/**
 * Retired route.
 *
 * The old `/share#access=…` link decoded a base64url payload and logged the
 * recipient in via a session cookie. The share model is now server-mediated:
 * links carry only an opaque token at `/v/<token>` and require no login. This
 * stub explains the change without depending on any of the old fragment/login
 * actions, so nothing dangles.
 */

import { Warning } from "@phosphor-icons/react/dist/ssr";
import { Card, IconBadge } from "../../components/ui";

export default function RetiredSharePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="max-w-md p-6">
        <div className="flex flex-col items-start gap-3">
          <IconBadge tone="red" className="h-9 w-9">
            <Warning size={18} weight="bold" aria-hidden="true" />
          </IconBadge>
          <div>
            <h1 className="font-serif text-lg font-semibold tracking-tight text-ink">
              This link format is no longer supported
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Shared links now use a new, more secure format. Ask the sender for a new link.
            </p>
          </div>
        </div>
      </Card>
    </main>
  );
}
