import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { NameInfo } from "../../api/portless";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ErrorState, LoadingState } from "../../components/States";
import { copyableUrl } from "../../lib/apps";
import { baseName, hostnameFor, proxyUrl, SOURCE_LABELS } from "../../lib/portless";
import { href } from "../../lib/router";
import type { DetailTabProps } from "../AppDetail";
import { RenameDialog } from "../domains/RenameDialog";
import { usePortlessStatus, useRefreshOnJobs, valueOf } from "../domains/store";
import { Placeholder } from "./Placeholder";

/** The app's address, where its name comes from, and "Change name" (plan §5.4). */
export function UrlTab({ ms, app }: DetailTabProps) {
  const ctx = useApp();
  const status = valueOf(usePortlessStatus().state);
  const [info, setInfo] = useState<NameInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const local = ms.machine.local;
  const usable = (local || ms.machine.status === "online") && !!ms.tools.portless;

  const load = () => {
    if (!usable) return;
    setError(null);
    ctx.api.portlessNameInfo(ms.machine.id, app.id).then(setInfo, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [ctx.api, ms.machine.id, app.id, app.hostname, usable]);
  useRefreshOnJobs(load);

  if (!local && ms.machine.status !== "online") {
    return (
      <Placeholder icon="globe" title={`${ms.machine.name} is offline`}>
        <p>Where this app's name lives shows here again once Portplane reaches {ms.machine.name} over SSH.</p>
      </Placeholder>
    );
  }
  if (!ms.tools.portless) {
    return (
      <Placeholder icon="globe" title={local ? "portless isn't installed" : `portless isn't installed on ${ms.machine.name}`}>
        <p>
          portless gives this app a stable https://name.localhost address.{" "}
          {local ? "Install it from Settings → Tools, then name the app here." : <>Install it from <a href={href({ view: "onboarding", machine: ms.machine.id, step: "install" })}>{ms.machine.name}'s setup</a>, then name the app here.</>}
        </p>
      </Placeholder>
    );
  }
  if (error) return <ErrorState title="Couldn't find where this app's name lives" message={error} onRetry={load} />;
  if (!info) return <LoadingState label="Finding the app's name…" />;

  const url = copyableUrl(app, ms.machine, ms.tools) ?? (app.hostname && status ? proxyUrl(app.hostname, status.proxy) : undefined);
  const others = status && app.hostname ? status.proxy.tlds.slice(1).map((t) => hostnameFor(baseName(app.hostname!, status.proxy.tlds), t)) : [];

  return (
    <div className="url-tab">
      <dl className="facts">
        <div className="facts-row">
          <dt>Address</dt>
          <dd>
            {url ? (
              <span className="fact-inline">
                <a className="addr" href={url} target="_blank" rel="noopener">
                  {url.replace(/^https?:\/\//, "")}
                </a>
                <IconButton icon="copy" label="Copy the URL" onClick={() => void copyWithToast(ctx, url, "the URL")} />
              </span>
            ) : (
              <span className="muted">None: this app doesn't run through portless</span>
            )}
          </dd>
        </div>
        {!local && app.url && (
          <div className="facts-row">
            <dt>On {ms.machine.name}</dt>
            <dd className="mono">{app.url.replace(/^https?:\/\//, "")}</dd>
          </div>
        )}
        {others.length > 0 && (
          <div className="facts-row">
            <dt>Also at</dt>
            <dd className="mono">{others.join(", ")}</dd>
          </div>
        )}
        <div className="facts-row">
          <dt>Name</dt>
          <dd>
            <span className="mono">{info.name || "—"}</span>
            {info.inferred && <span className="muted"> · worked out by portless</span>}
            {info.runMode && info.prefix && <span className="muted"> · portless run adds “{info.prefix}.” for this worktree</span>}
          </dd>
        </div>
        <div className="facts-row">
          <dt>Comes from</dt>
          <dd>
            {SOURCE_LABELS[info.source]}
            {info.file && <span className="fact-path mono"> {info.file}</span>}
            {info.source === "config" && info.dir && (
              <>
                {" · "}
                <a href={href({ view: "domains", section: "config", machine: ms.machine.id })}>edit portless.json</a>
              </>
            )}
          </dd>
        </div>
      </dl>
      {info.editable ? (
        <button type="button" className="btn btn-primary" onClick={() => setRenaming(true)}>
          <Icon name="pencil" size={13} />
          Change name
        </button>
      ) : (
        info.reason && <p className="fact-note">{info.reason}</p>
      )}
      {info.notes.map((n) => (
        <p key={n} className="fact-note">
          {n}
        </p>
      ))}
      {renaming && <RenameDialog machine={ms.machine.id} appId={app.id} label={app.label} runner={app.runner} onClose={() => setRenaming(false)} />}
    </div>
  );
}
