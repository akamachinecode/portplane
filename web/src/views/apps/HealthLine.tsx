import { Icon } from "../../components/Icon";
import { href } from "../../lib/router";
import { useShell } from "../../shell/ShellContext";

/**
 * One compact line in place of the banners the Apps page had: how many
 * problems there are, the first two, and a link to Health, where each one
 * has its explanation and fix (plan §6.4).
 */
export function HealthLine() {
  const { problems } = useShell();
  const serious = problems.filter((p) => p.severity !== "info");
  const list = serious.length ? serious : problems;
  if (list.length === 0) return null;
  const tone = list.some((p) => p.severity === "error") ? "error" : serious.length ? "warn" : "info";
  const n = list.length;
  const what = serious.length ? (n === 1 ? "1 problem" : `${n} problems`) : n === 1 ? "1 note" : `${n} notes`;
  const named = list.slice(0, 2).map((p) => (p.machine && !p.title.includes(p.machine.name) && p.machine.id !== "local" ? `${p.title} (${p.machine.name})` : p.title));
  const more = n > 2 ? ` and ${n - 2} more` : "";
  return (
    <a className={`health-line health-line-${tone}`} href={href({ view: "health" })}>
      <Icon name={tone === "info" ? "info" : "warning"} size={15} className="health-line-icon" />
      <span className="health-line-text">
        <strong>{what}:</strong> {named.join(" · ")}
        {more}
      </span>
      <span className="health-line-go">
        Open Health
        <Icon name="arrowRight" size={14} />
      </span>
    </a>
  );
}
