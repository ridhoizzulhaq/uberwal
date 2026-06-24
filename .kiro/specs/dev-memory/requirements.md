# Requirements Document

## Introduction

DevMemory is an MCP server for Claude Code that transforms coding sessions into verified memories stored on Walrus Memory (MemWal). It provides tools for capturing session transcripts, extracting skills and productivity metrics, generating reports, and sharing insights. A companion Next.js dashboard allows users to view their skills portfolio, productivity insights, session history, and reports — with role-based shared views for developers, team leads, and recruiters.

Session capture follows a two-phase capture-with-review workflow. When a session ends, the MCP_Server extracts a candidate session summary, candidate skill facts, and candidate productivity metrics, and returns them to the developer as a Preview WITHOUT writing anything to MemWal. The developer then reviews the Preview, approves or rejects each Candidate_Fact individually, and only the approved Candidate_Facts are stored into their namespaces. Nothing — including the raw session summary — enters MemWal until it has been approved. Because MCP tools are stateless across calls, the extraction tool returns the Candidate_Facts (each with a stable identifier, a type, and its text) to the caller, and the developer passes the approved Candidate_Facts back to the commit tool; DevMemory does not maintain a server-side staging store between the two phases.

## Glossary

- **MCP_Server**: The Model Context Protocol server built with TypeScript and @modelcontextprotocol/sdk that exposes tools for memory operations to Claude Code
- **MemWal**: The Walrus Memory SDK (@mysten-incubation/memwal) used for storing and recalling semantic memories via a relayer service
- **Namespace**: An isolation boundary in MemWal defined by owner + namespace string; DevMemory uses four namespaces: sessions, skills, productivity, and reports
- **Session_Transcript**: The raw text content of a coding session between a user and Claude Code
- **Fact_Extraction**: The process of analyzing a session transcript to identify discrete skill facts and productivity metrics using Claude API or MemWal's analyzeAndWait
- **Candidate_Fact**: An individual item produced during extraction — a candidate session summary, a candidate skill fact, or a candidate productivity metric — that carries a stable identifier, a type (session, skill, or productivity), and text content, and is presented for review without being stored until approved
- **Preview**: The complete set of Candidate_Facts returned by the extract_session tool for the developer to review before any storage occurs
- **Approval**: The developer's decision to accept specific Candidate_Facts for storage; only approved Candidate_Facts are written to MemWal, and rejected Candidate_Facts are discarded
- **extract_session**: The MCP tool that performs the extraction/preview phase — it validates the transcript, extracts Candidate_Facts via Claude API, and returns the Preview to the developer without writing to MemWal
- **commit_session**: The MCP tool that performs the review/commit phase — it receives the approved Candidate_Facts and stores each one into the namespace matching its type
- **Delegate_Key**: A MemWal credential (Ed25519 private key in hex) that grants access to a specific account's memories, used for sharing
- **Dashboard**: The Next.js + Tailwind web application for viewing and searching memories
- **Distance_Score**: A float value from MemWal's recall indicating semantic similarity; lower values mean higher relevance (< 0.25 = duplicate, 0.25–0.55 = related, 0.55–0.7 = weak, >= 0.7 = unrelated)
- **Role_Selector**: A UI control that determines which namespaces are visible based on viewer role (developer, team lead, recruiter)
- **Relayer**: The mainnet server (https://relayer.memory.walrus.xyz) that handles MemWal API requests

## Requirements

### Requirement 1: Extract and Preview Coding Session

**User Story:** As a developer, I want my completed coding session to be analyzed into candidate facts that I can preview before anything is stored, so that I control exactly what becomes part of my permanent memory.

#### Acceptance Criteria

1. WHEN the user invokes the extract_session tool with a session transcript, THE MCP_Server SHALL derive a candidate session summary, a set of candidate skill facts, and a set of candidate productivity metrics from the transcript using Claude API (claude-sonnet-4-20250514) without storing any content in the sessions, skills, or productivity namespaces
2. WHEN the extract_session tool produces Candidate_Facts, THE MCP_Server SHALL assign each Candidate_Fact a stable identifier and a type label of session, skill, or productivity
3. WHEN the extract_session tool completes extraction, THE MCP_Server SHALL return the Preview containing every Candidate_Fact with its identifier, type, and text content so that the developer can approve or reject each Candidate_Fact individually
4. IF the session transcript is empty, contains only whitespace, or is missing, THEN THE MCP_Server SHALL return a validation error without invoking fact extraction
5. IF the extraction via Claude API fails, THEN THE MCP_Server SHALL return an error message indicating extraction failed without storing any content in any namespace

### Requirement 2: Recall Memories

**User Story:** As a developer, I want to recall specific memories from my stored sessions, so that I can retrieve relevant context from past work.

#### Acceptance Criteria

1. WHEN the user invokes the recall_memory tool with a query and namespace, THE MCP_Server SHALL perform a semantic search using MemWal's recall method on the specified namespace
2. WHEN the user invokes the recall_memory tool with an optional limit parameter, THE MCP_Server SHALL pass the limit to MemWal's recall method with a default of 10 and a valid range of 1 to 100
3. WHEN the user invokes the recall_memory tool with an optional maxDistance parameter, THE MCP_Server SHALL pass the maxDistance to MemWal's recall method with a default of 0.7
4. WHEN recall results are returned, THE MCP_Server SHALL include the blob_id, text, distance score, and total count for each result
5. IF no results are found within the specified maxDistance, THEN THE MCP_Server SHALL return an empty result set with a message indicating no relevant memories were found
6. IF the namespace parameter is not one of sessions, skills, productivity, or reports, THEN THE MCP_Server SHALL return a validation error indicating the invalid namespace
7. IF the query parameter is empty or missing, THEN THE MCP_Server SHALL return a validation error indicating a query is required
8. IF the MemWal relayer is unreachable, THEN THE MCP_Server SHALL return an error message indicating the service is unavailable

### Requirement 3: Skills Shortcut

**User Story:** As a developer, I want a quick way to recall my skills, so that I can review my technical capabilities without specifying namespace details.

#### Acceptance Criteria

1. WHEN the user invokes the my_skills tool with a query, THE MCP_Server SHALL perform a recall on the skills namespace with the provided query and a default limit of 10 results, returning the results in the same format as the recall_memory tool (blob_id, text, distance, and total)
2. WHEN the user invokes the my_skills tool without a query, THE MCP_Server SHALL perform a recall on the skills namespace using a general-purpose query of "skills and technologies" with a default limit of 10 results
3. IF the recall operation on the skills namespace fails, THEN THE MCP_Server SHALL return an error message indicating the skills recall was unsuccessful

### Requirement 4: Productivity Shortcut

**User Story:** As a developer, I want a quick way to recall my productivity metrics, so that I can review my output and progress without specifying namespace details.

#### Acceptance Criteria

1. WHEN the user invokes the my_productivity tool with a query, THE MCP_Server SHALL perform a recall on the productivity namespace with the provided query and a default limit of 10 results, returning the results in the same format as the recall_memory tool (blob_id, text, distance, and total)
2. WHEN the user invokes the my_productivity tool without a query, THE MCP_Server SHALL perform a recall on the productivity namespace using a general-purpose query of "productivity and output" with a default limit of 10 results
3. IF the recall operation on the productivity namespace fails, THEN THE MCP_Server SHALL return an error message indicating the productivity recall was unsuccessful

### Requirement 5: Generate Report

**User Story:** As a developer, I want to generate aggregated reports from my memories, so that I can get summarized insights across multiple sessions.

#### Acceptance Criteria

1. WHEN the user invokes the generate_report tool, THE MCP_Server SHALL recall up to 50 entries from the skills namespace and up to 50 entries from the productivity namespace
2. WHEN entries are recalled for a report, THE MCP_Server SHALL aggregate and summarize the entries using Claude API (claude-sonnet-4-20250514), covering skill portfolio highlights and productivity patterns
3. WHEN a report summary is generated, THE MCP_Server SHALL store the report in a reports namespace using rememberAndWait
4. WHEN the report is stored, THE MCP_Server SHALL return the generated summary to the user
5. IF fewer than 3 entries exist across the skills and productivity namespaces combined, THEN THE MCP_Server SHALL return a message indicating not enough data is available for report generation
6. IF the Claude API call fails during summarization, THEN THE MCP_Server SHALL return an error message indicating the report could not be generated due to a summarization failure

### Requirement 6: Generate Share Info

**User Story:** As a developer, I want to generate sharing information, so that I can share my skill portfolio or productivity data with others using delegate keys.

#### Acceptance Criteria

1. WHEN the user invokes the generate_share_info tool, THE MCP_Server SHALL output the delegate public key hex (via getPublicKeyHex()), the account ID, and the relayer URL required for shared access
2. WHEN share info is generated, THE MCP_Server SHALL NOT include the delegate private key in the output
3. WHEN share info is generated, THE MCP_Server SHALL include instructions describing how the recipient can use the provided credentials to log into the Dashboard and how to generate a separate delegate key via the MemWal dashboard at the staging URL
4. IF the delegate key is not configured or unavailable, THEN THE MCP_Server SHALL return an error message indicating that a delegate key must be set up before sharing

### Requirement 7: Dashboard Authentication

**User Story:** As a viewer, I want to log into the dashboard using a delegate key and account ID, so that I can access shared memories.

#### Acceptance Criteria

1. WHEN a viewer provides a delegate key and account ID on the login page and submits the form, THE Dashboard SHALL call MemWal's health() method with the provided credentials and, upon a successful response within 10 seconds, store the credentials client-side and navigate the viewer to the dashboard home page
2. IF the MemWal health() call returns an authentication failure response, THEN THE Dashboard SHALL display an error message indicating invalid credentials and keep the viewer on the login page with the form fields preserved
3. IF the delegate key or account ID fields are empty, THEN THE Dashboard SHALL disable the login button and display a validation message next to the empty field
4. IF the delegate key is not a valid 64-character hexadecimal string or the account ID is not a valid 0x-prefixed 64-character hexadecimal string, THEN THE Dashboard SHALL disable the login button and display a validation message indicating the expected format
5. IF the MemWal health() call fails due to a network error or does not respond within 10 seconds, THEN THE Dashboard SHALL display an error message indicating a connectivity problem, distinguishable from the invalid credentials error, and allow the viewer to retry

### Requirement 8: Dashboard Skills View

**User Story:** As a viewer, I want to see skills displayed as cards, so that I can quickly understand the developer's technical capabilities.

#### Acceptance Criteria

1. WHEN the viewer navigates to the "My Skills" tab, THE Dashboard SHALL perform a recall on the skills namespace using a broad default query with a maximum of 20 results and display each returned entry as a card
2. WHEN a skill card is displayed, THE Dashboard SHALL show the skill fact text prominently and display its distance score as a numeric value (e.g., 0.32) as a secondary indicator
3. WHEN the viewer submits a query via the search box on the skills tab (by pressing Enter or activating a search button), THE Dashboard SHALL perform a natural language recall on the skills namespace with the submitted query and replace the currently displayed cards with the new results within 5 seconds
4. IF the recall operation on the skills namespace fails, THEN THE Dashboard SHALL display an error message indicating that skills could not be loaded and retain any previously displayed cards
5. IF the recall returns zero results, THEN THE Dashboard SHALL display an empty state message indicating no skills were found for the current query

### Requirement 9: Dashboard Productivity View

**User Story:** As a viewer, I want to see productivity metrics, so that I can understand the developer's output and work patterns.

#### Acceptance Criteria

1. WHEN the viewer navigates to the "My Productivity" tab, THE Dashboard SHALL perform a recall on the productivity namespace using a broad default query with a maximum of 20 results and display each entry as a card showing the productivity fact text and its distance score
2. WHEN the viewer submits a query via the search box on the productivity tab (by pressing Enter or activating a search button), THE Dashboard SHALL perform a natural language recall on the productivity namespace with the submitted query and replace the currently displayed results within 5 seconds
3. IF the recall operation on the productivity namespace fails, THEN THE Dashboard SHALL display an error message indicating that productivity data could not be loaded and retain any previously displayed entries
4. IF the recall returns zero results, THEN THE Dashboard SHALL display an empty state message indicating no productivity data was found for the current query

### Requirement 10: Dashboard Sessions View

**User Story:** As a viewer, I want to browse raw session summaries, so that I can review the original context of coding sessions.

#### Acceptance Criteria

1. WHEN the viewer navigates to the "Sessions" tab, THE Dashboard SHALL recall up to 20 entries from the sessions namespace and display each session summary as a text block showing the summary text truncated to 300 characters and its distance score
2. WHEN a session summary text exceeds 300 characters, THE Dashboard SHALL display a control to expand the entry and reveal the full summary text
3. WHEN the viewer submits a query via the search box on the sessions tab, THE Dashboard SHALL perform a natural language recall on the sessions namespace and update displayed results within 2 seconds of submission
4. IF the recall from the sessions namespace returns no results, THEN THE Dashboard SHALL display a message indicating no session summaries were found

### Requirement 11: Dashboard Reports View

**User Story:** As a viewer, I want to view generated reports, so that I can see aggregated insights and summaries.

#### Acceptance Criteria

1. WHEN the viewer navigates to the "Reports" tab, THE Dashboard SHALL recall up to 10 entries from the reports namespace and display each report entry with its full text rendered with paragraph formatting
2. WHEN the viewer submits a query via the search box on the reports tab, THE Dashboard SHALL perform a natural language recall on the reports namespace and update displayed results
3. IF the recall from the reports namespace returns no results, THEN THE Dashboard SHALL display a message indicating no reports have been generated yet

### Requirement 12: Dashboard Relevance Filter

**User Story:** As a viewer, I want to control the relevance threshold of search results, so that I can filter out weak or unrelated matches.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a maxDistance slider control on each tab with a range from 0.0 to 1.0, a step increment of 0.01, and a default value of 0.7
2. WHEN the viewer adjusts the maxDistance slider, THE Dashboard SHALL debounce the input for 300ms and then re-execute the current recall query with the updated maxDistance value
3. THE Dashboard SHALL display the current maxDistance value to 2 decimal places adjacent to the slider
4. IF the recall query triggered by a slider adjustment fails, THEN THE Dashboard SHALL display an error message indicating the query failure and retain the previous search results

### Requirement 13: Role-Based Shared Views

**User Story:** As a team lead or recruiter, I want to see only the information relevant to my role, so that I can focus on what matters for my evaluation.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a role selector on the login page with three options: developer, team lead, and recruiter, defaulting to developer if no prior selection exists in session storage
2. WHILE the role is set to developer, THE Dashboard SHALL display all tabs (My Skills, My Productivity, Sessions, Reports)
3. WHILE the role is set to team lead, THE Dashboard SHALL display only the My Productivity and Reports tabs
4. WHILE the role is set to recruiter, THE Dashboard SHALL display only the My Skills tab
5. WHEN the viewer changes the role selector, THE Dashboard SHALL update the visible tabs without requiring a page reload, and navigate to the first available tab for the new role if the currently active tab is not visible under the selected role
6. WHEN the viewer selects a role, THE Dashboard SHALL persist the selected role in session storage so that the selection is retained across page refreshes within the same browser session

### Requirement 14: MemWal Health Check

**User Story:** As a developer, I want to verify the MemWal relayer is available, so that I know my memory operations will succeed.

#### Acceptance Criteria

1. WHEN the MCP_Server starts, THE MCP_Server SHALL verify relayer connectivity using MemWal's health() method with a timeout of 5 seconds; a successful response is one where the status field equals "ok"
2. IF the relayer health check fails on startup, THEN THE MCP_Server SHALL log a warning indicating the relayer is unreachable but continue startup normally
3. WHEN any tool is invoked, THE MCP_Server SHALL verify relayer health before executing the memory operation with a timeout of 5 seconds
4. IF the per-tool health check fails, THEN THE MCP_Server SHALL return an error message indicating the relayer is unavailable without attempting the memory operation

### Requirement 15: Review and Commit Approved Facts

**User Story:** As a developer, I want to approve or reject the candidate facts from a previewed session and store only the approved ones, so that only information I have reviewed enters MemWal.

#### Acceptance Criteria

1. WHEN the user invokes the commit_session tool with a set of approved Candidate_Facts, where each approved Candidate_Fact carries the identifier, type, and text returned in the extract_session Preview, THE MCP_Server SHALL store each approved Candidate_Fact into the namespace matching its type using MemWal's rememberAndWait method, storing session-type facts in the sessions namespace, skill-type facts in the skills namespace, and productivity-type facts in the productivity namespace
2. WHEN the commit_session tool stores an approved Candidate_Fact of type session, THE MCP_Server SHALL use a rememberAndWait timeout of 30000ms
3. WHEN the developer approves a subset of the Candidate_Facts and rejects the remainder, THE MCP_Server SHALL limit storage to the Candidate_Facts included in the approved set
4. WHEN the commit_session operation completes, THE MCP_Server SHALL report, for each approved Candidate_Fact, whether its storage succeeded or failed
5. IF any individual approved Candidate_Fact storage fails, THEN THE MCP_Server SHALL continue storing the remaining approved Candidate_Facts and report which approved Candidate_Facts succeeded and which failed in the response
6. IF the MemWal relayer is unreachable when commit_session is invoked, THEN THE MCP_Server SHALL return an error message indicating the relayer health check failed without attempting storage
7. IF the approved set of Candidate_Facts is empty or missing, THEN THE MCP_Server SHALL return a validation error without attempting storage
8. IF an approved Candidate_Fact specifies a type that is not session, skill, or productivity, THEN THE MCP_Server SHALL return a validation error identifying the invalid Candidate_Fact without storing it
