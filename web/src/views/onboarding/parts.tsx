import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CommandPreview } from "../../api/tools";
import { useApp } from "../../components/AppContext";
import { copyWithToast } from "../../components/appActions";
import { Icon, Spinner, type IconName } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useOnboarding } from "./context";
import { prevStep } from "./steps";

/** One step's page: icon, title and lead, the content, and its own footer. */
export function StepLayout({
  icon,
  title,
  lead,
  children,
  footer,
  busy,
}: {
  icon: IconName;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  busy?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  // Each step starts at its title, for keyboard and screen reader users,
  // and the timeline scrolls to it (ADR-0028).
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest(".tl-item")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  return (
    <section className="ob-step" aria-labelledby={id} aria-busy={busy || undefined}>
      <header className="ob-step-head">
        <span className="ob-step-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <div className="ob-step-titles">
          <h2 className="ob-step-title" id={id} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {lead && <p className="ob-step-lead">{lead}</p>}
        </div>
      </header>
      <div className="ob-step-body">{children}</div>
      <footer className="ob-foot">{footer}</footer>
    </section>
  );
}

/** Back on the left (unless first), the step's own actions on the right. */
export function StepFooter({ children, status, noBack }: { children?: ReactNode; status?: ReactNode; noBack?: boolean }) {
  const { step, go } = useOnboarding();
  return (
    <>
      {!noBack && step !== "welcome" && (
        <button type="button" className="btn btn-ghost" onClick={() => go(prevStep(step))}>
          <Icon name="chevronLeft" size={14} />
          Back
        </button>
      )}
      <span className="ob-foot-status" role="status">
        {status}
      </span>
      {children}
    </>
  );
}

/** A primary "Next" that goes on to the next step worth showing. */
export function NextButton({ label = "Next", primary = true, disabled }: { label?: string; primary?: boolean; disabled?: boolean }) {
  const { next } = useOnboarding();
  return (
    <button type="button" className={primary ? "btn btn-primary" : "btn"} onClick={next} disabled={disabled}>
      {label}
      <Icon name="chevronRight" size={14} />
    </button>
  );
}

/** A small status mark: done, problem, warning, waiting. */
export function Mark({ tone, label }: { tone: "ok" | "bad" | "warn" | "info" | "busy" | "idle"; label: string }) {
  const icon: Record<typeof tone, IconName | null> = { ok: "checkCircle", bad: "xCircle", warn: "warning", info: "info", busy: null, idle: "circle" };
  const name = icon[tone];
  return (
    <span className={`ob-mark ob-mark-${tone}`}>
      {name ? <Icon name={name} size={16} /> : <Spinner size={15} />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A copyable command, with a copy button that says what it copied. */
export function CopyCommand({ command, label = "the command" }: { command: string; label?: string }) {
  const app = useApp();
  return (
    <div className="cmd ob-cmd">
      <code className="cmd-text">{command}</code>
      <IconButton icon="copy" label={`Copy ${label}`} onClick={() => void copyWithToast(app, command, label)} />
    </div>
  );
}

/**
 * The exact privileged command before the click (ADR-0020): one argument
 * per line and the environment that goes with it, plus the line to paste
 * in a terminal to do it by hand.
 */
export function PrivilegedPreview({ preview }: { preview: CommandPreview }) {
  const [open, setOpen] = useState(false);
  const envKeys = Object.keys(preview.env).sort();
  return (
    <div className="ob-priv">
      <p className="ob-priv-title">
        <Icon name="terminal" size={14} />
        {preview.needsAdmin ? "Runs as administrator, exactly this:" : "Runs as you, exactly this:"}
      </p>
      <ol className="ob-argv mono" aria-label="Arguments, one per line">
        {preview.argv.map((a, i) => (
          <li key={`${i}-${a}`}>{a}</li>
        ))}
      </ol>
      {envKeys.length > 0 && (
        <details className="ob-env" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>
            With {envKeys.length === 1 ? "one variable" : `${envKeys.length} variables`} from your session, so portless keeps its files in your home
          </summary>
          <dl className="ob-env-list mono">
            {envKeys.map((k) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{preview.env[k]}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
