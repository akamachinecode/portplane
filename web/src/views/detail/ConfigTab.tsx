import type { DetailTabProps } from "../AppDetail";
import { Placeholder } from "./Placeholder";

/** The task's settings as a form (plan §4.4, M5.3). */
export function ConfigTab({ app }: DetailTabProps) {
  return (
    <Placeholder icon="pencil" title="Editing the task is coming">
      <p>
        This tab will edit the <code>{app.task}</code> task: its command, folder, environment, dependencies and restart policy, with a
        preview of the change before it's saved.
      </p>
      <p>
        Until then, edit <code>dekit.yaml</code> in your editor; Portplane picks up the change.
      </p>
    </Placeholder>
  );
}
