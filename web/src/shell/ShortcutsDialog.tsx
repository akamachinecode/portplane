import { useApp } from "../components/AppContext";
import { Dialog } from "../components/Dialog";
import { isMac } from "../lib/keyboard";
import { shortcutGroups } from "../lib/shortcuts";
import "./shortcuts.css";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** "?": every keyboard shortcut, by where it works (plan §6.3). */
export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const { info } = useApp();
  const groups = shortcutGroups(isMac(info?.os));
  return (
    <Dialog open onClose={onClose} title="Keyboard shortcuts" size="sm">
      <p className="dialog-text muted">Single keys work when you are not typing in a field.</p>
      <div className="shortcuts">
        {groups.map((g) => (
          <section key={g.title} className="shortcuts-group" aria-labelledby={`sc-${slug(g.title)}`}>
            <h3 className="shortcuts-title" id={`sc-${slug(g.title)}`}>
              {g.title}
            </h3>
            <dl className="shortcuts-list">
              {g.items.map((item) => (
                <div key={item.label} className="shortcut">
                  <dt className="shortcut-keys">
                    {item.keys.map((k, i) => (
                      <span key={i}>
                        {i > 0 && <span className="shortcut-then">{item.join ?? "+"}</span>}
                        <kbd className="kbd">{k}</kbd>
                      </span>
                    ))}
                  </dt>
                  <dd className="shortcut-label">{item.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
