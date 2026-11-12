import { EmptyState } from "../../components/States";

/** portless aliases (plan §5.3, M5.2). */
export function AliasesSection() {
  return (
    <EmptyState icon="plug" title="Aliases are coming">
      An alias gives a stable URL to a server portless can't start, such as a database UI or a Docker container. A later version adds and removes them here.
    </EmptyState>
  );
}
