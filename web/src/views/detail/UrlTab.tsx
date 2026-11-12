import type { DetailTabProps } from "../AppDetail";
import { Placeholder } from "./Placeholder";

/** The app's domain name (plan §5.4, M5.2). */
export function UrlTab({ app }: DetailTabProps) {
  return (
    <Placeholder icon="globe" title="Changing the URL is coming">
      <p>
        This tab will rename {app.hostname ? <code>{app.hostname}</code> : "the app's address"}, check the new name as you type, and
        update the config for you.
      </p>
      <p>Until then, change the name after <code>portless</code> in the task's command.</p>
    </Placeholder>
  );
}
