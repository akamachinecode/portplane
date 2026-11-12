import { EmptyState } from "../../components/States";

/** portless's block in /etc/hosts (plan §5.7, M5.2). */
export function HostsSection() {
  return (
    <EmptyState icon="terminal" title="The hosts file is coming">
      Names under .localhost need no hosts file. A later version manages the entries portless adds for other domains.
    </EmptyState>
  );
}
