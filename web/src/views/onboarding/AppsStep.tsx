import type { Proposal } from "../../api/types";
import { Banner } from "../../components/Banner";
import { Icon, Spinner } from "../../components/Icon";
import { SetupApps } from "../../components/SetupApps";
import { inferHome, shortenPath } from "../../lib/format";
import { isIncluded, NO_EDITS } from "../../lib/setup";
import { useOnboarding } from "./context";
import { NextButton, StepFooter, StepLayout } from "./parts";
import { hasFixedPorts, missingManagers } from "./helpers";
import { count, sentence } from "./summary";

function FolderApps({ folder, home }: { folder: string; home: string | undefined }) {
  const { scans, edits, setEdits } = useOnboarding();
  const scan = scans[folder];
  const e = edits[folder] ?? NO_EDITS;
  const name = shortenPath(folder, home);

  const onName = (task: string, value: string | undefined) =>
    setEdits(folder, (cur) => {
      const names = { ...cur.names };
      if (value === undefined) delete names[task];
      else names[task] = value;
      return { ...cur, names };
    });
  const onInclude = (task: string, include: boolean) => setEdits(folder, (cur) => ({ ...cur, skip: { ...cur.skip, [task]: !include } }));
  const onIncludeAll = (tasks: string[], include: boolean) =>
    setEdits(folder, (cur) => ({ ...cur, skip: { ...cur.skip, ...Object.fromEntries(tasks.map((t) => [t, !include])) } }));

  return (
    <section className="ob-folder-apps" aria-label={`Apps in ${name}`}>
      <h2 className="ob-folder-apps-title">
        <Icon name="folder" size={15} />
        <span className="mono">{name}</span>
        {scan?.scanning && scan.proposal && <Spinner size={12} />}
      </h2>
      {!scan || (!scan.proposal && !scan.error) ? (
        <p className="dialog-loading">
          <Spinner /> Looking for apps in <span className="mono">{name}</span>…
        </p>
      ) : null}
      {scan?.error && (
        <Banner
          tone="error"
          title="Couldn't scan this folder"
          action={
            <button type="button" className="btn" onClick={() => void scan.rescan()} disabled={scan.scanning}>
              Try again
            </button>
          }
        >
          {scan.error}
        </Banner>
      )}
      {scan?.proposal && <SetupApps proposal={scan.proposal} edits={e} onName={onName} onInclude={onInclude} onIncludeAll={onIncludeAll} />}
      {scan?.proposal && hasFixedPorts(scan.proposal) && (
        <p className="ob-note muted">
          <Icon name="info" size={13} /> Some dev scripts fix their port (like <code>--port 3001</code>), which would win over the free port portless
          gives each app. The note under each of those apps says what Portplane does about it.
        </p>
      )}
    </section>
  );
}

/** Step 6: the apps each folder holds, with their addresses to edit. */
export function AppsStep() {
  const { folders, scans, edits, checks, go } = useOnboarding();
  const home = inferHome(folders);
  const proposals = folders.map((f) => scans[f]?.proposal).filter((p): p is Proposal => !!p);
  const scanning = folders.some((f) => !scans[f] || scans[f].scanning);
  const included = proposals.flatMap((p) => p.apps.filter((a) => isIncluded(a, edits[p.folder] ?? NO_EDITS)));
  const missing = missingManagers(proposals, checks.items.packages?.managers, (task) => {
    const p = proposals.find((x) => x.apps.some((a) => a.task === task));
    const a = p?.apps.find((x) => x.task === task);
    return !p || !a || !isIncluded(a, edits[p.folder] ?? NO_EDITS);
  });

  if (folders.length === 0) {
    return (
      <StepLayout
        icon="apps"
        title="Your apps"
        footer={
          <StepFooter>
            <button type="button" className="btn btn-primary" onClick={() => go("folders")}>
              Choose folders
            </button>
          </StepFooter>
        }
      >
        <p className="muted">Choose the folders with your projects first.</p>
      </StepLayout>
    );
  }

  return (
    <StepLayout
      icon="apps"
      title="Your apps"
      lead="These are the dev servers Portplane found. Untick the ones you don't want, and change any address: it becomes https://<name>.localhost."
      busy={scanning}
      footer={
        <StepFooter status={scanning ? "Scanning…" : included.length ? sentence(`${count(included.length, "app")} to set up.`) : "No apps chosen."}>
          <NextButton label="Review the changes" disabled={proposals.length === 0} />
        </StepFooter>
      }
    >
      {missing.length > 0 && (
        <Banner tone="warn" title={`${missing.join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} installed`}>
          Some of these apps install and start with {missing.join(" and ")}. Install {missing.length === 1 ? "it" : "them"} (for example{" "}
          <code>{missing.includes("pnpm") ? "npm install -g pnpm" : `npm install -g ${missing[0]}`}</code>) before you start them.
        </Banner>
      )}
      {folders.map((f) => (
        <FolderApps key={f} folder={f} home={home} />
      ))}
    </StepLayout>
  );
}
