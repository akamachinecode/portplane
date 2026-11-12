import { CommandLine } from "../../components/Controls";
import type { DetailTabProps } from "../AppDetail";
import { Placeholder } from "./Placeholder";

/** The app's live output (plan D4, M5.4). For now: how to see it in a terminal. */
export function OutputTab({ app }: DetailTabProps) {
  return (
    <Placeholder icon="terminal" title="Live output is coming">
      <p>This tab will show what the app prints, live, with search and copy.</p>
      <p>Until then, dekit shows it in a terminal:</p>
      <CommandLine command={`dekit -C ${app.runner} screen ${app.task}`} />
    </Placeholder>
  );
}
