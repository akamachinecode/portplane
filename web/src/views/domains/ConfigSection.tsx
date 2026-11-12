import { useEffect, useId, useMemo, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import type { AppConfig, ConfigPlace, ConfigPreview, ConfigTarget, ProjectConfig, ProjectConfigs } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { Field } from "../../components/Controls";
import { FileDiff } from "../../components/FileDiff";
import { Icon, Spinner } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useMachineScope } from "../../components/MachineScope";
import { Segmented } from "../../components/Segmented";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { inferHome, shortenPath } from "../../lib/format";
import { checkConfigText, configText, extraKeys, nameProblem } from "../../lib/portless";
import { appRoute, href } from "../../lib/router";
import { SettingsGroup } from "../settings/SettingsGroup";
import { StatusGate } from "./ProxySection";

type Tri = "default" | "yes" | "no";
const tri = (v: boolean | undefined): Tri => (v === undefined ? "default" : v ? "yes" : "no");
const untri = (v: Tri): boolean | undefined => (v === "default" ? undefined : v === "yes");

function TriSelect({ id, value, onChange, labels }: { id: string; value: boolean | undefined; onChange(v: boolean | undefined): void; labels: [string, string, string] }) {
  return (
    <select id={id} className="input select" value={tri(value)} onChange={(e) => onChange(untri(e.target.value as Tri))}>
      <option value="default">{labels[0]}</option>
      <option value="yes">{labels[1]}</option>
      <option value="no">{labels[2]}</option>
    </select>
  );
}

function AppFields({ value, onChange, prefix }: { value: AppConfig; onChange(next: AppConfig): void; prefix: string }) {
  const ids = { name: useId(), script: useId(), port: useId(), proxy: useId() };
  const nameErr = value.name ? nameProblem(value.name) : null;
  return (
    <div className="config-fields">
      <Field label="Name" htmlFor={ids.name} error={nameErr} hint={prefix ? undefined : "The app's address: name.localhost. Empty: portless uses package.json's name."}>
        <input id={ids.name} className="input mono" value={value.name ?? ""} placeholder="web" onChange={(e) => onChange({ ...value, name: e.target.value || undefined })} />
      </Field>
      <Field label="Script" htmlFor={ids.script} hint={prefix ? undefined : "The package.json script portless runs; dev when empty."}>
        <input id={ids.script} className="input mono" value={value.script ?? ""} placeholder="dev" onChange={(e) => onChange({ ...value, script: e.target.value || undefined })} />
      </Field>
      <Field label="App port" htmlFor={ids.port} hint={prefix ? undefined : "Only when the app ignores the PORT portless gives it."}>
        <input id={ids.port} className="input mono port-input" type="number" min={1} max={65535} value={value.appPort ?? ""} placeholder="auto" onChange={(e) => onChange({ ...value, appPort: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : undefined })} />
      </Field>
      <Field label="Proxy" htmlFor={ids.proxy}>
        <TriSelect id={ids.proxy} value={value.proxy} onChange={(proxy) => onChange({ ...value, proxy })} labels={["Default (yes)", "Yes", "No: run it without an address"]} />
      </Field>
    </div>
  );
}

function Form({ config, onChange }: { config: ProjectConfig; onChange(next: ProjectConfig): void }) {
  const turboId = useId();
  const apps = Object.entries(config.apps ?? {});
  const setApp = (i: number, path: string, value: AppConfig) => {
    const next = apps.map(([p, v], j) => (j === i ? [path, value] : [p, v]) as [string, AppConfig]);
    onChange({ ...config, apps: Object.fromEntries(next) });
  };
  return (
    <div className="form-grid">
      <AppFields value={config} onChange={(v) => onChange({ ...config, ...v })} prefix="" />
      <Field label="Turborepo" htmlFor={turboId} hint={<>Whether <code>portless</code> at a monorepo root runs the apps through turbo.</>}>
        <TriSelect id={turboId} value={config.turbo} onChange={(turbo) => onChange({ ...config, turbo })} labels={["Default (when turbo.json exists)", "Yes", "No"]} />
      </Field>
      <div className="field">
        <span className="field-label">Apps of a monorepo</span>
        <p className="field-hint">
          For a config at a monorepo's root: settings per app folder, used when <code>portless</code> starts every app at once.
        </p>
        {apps.map(([path, value], i) => (
          <fieldset key={i} className="config-app">
            <legend className="sr-only">App {path || i + 1}</legend>
            <div className="config-app-head">
              <input className="input mono" value={path} placeholder="apps/web" aria-label="App folder" onChange={(e) => setApp(i, e.target.value, value)} />
              <IconButton icon="close" label={`Remove ${path || "this app"}`} onClick={() => onChange({ ...config, apps: Object.fromEntries(apps.filter((_, j) => j !== i)) })} />
            </div>
            <AppFields value={value} onChange={(v) => setApp(i, path, v)} prefix={`apps.${path}.`} />
          </fieldset>
        ))}
        <div>
          <button type="button" className="btn btn-sm" onClick={() => onChange({ ...config, apps: { ...(config.apps ?? {}), "": {} } })} disabled={apps.some(([p]) => !p)}>
            <Icon name="plus" size={13} />
            Add an app folder
          </button>
        </div>
      </div>
    </div>
  );
}

function Editor({ place, home }: { place: ConfigPlace; home: string | undefined }) {
  const { api, toast } = useApp();
  const { id: machine } = useMachineScope();
  const [configs, setConfigs] = useState<ProjectConfigs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConfigTarget>("portless.json");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = (c: ProjectConfigs, t: ConfigTarget) => {
    const src = t === "portless.json" ? c.portless : c.package;
    setText(src.text ? (src.text.endsWith("\n") ? src.text : src.text + "\n") : "{}\n");
    setPreview(null);
    setError(null);
  };
  const load = () => {
    setLoadError(null);
    api.portlessConfig(place.dir).then(
      (c) => {
        setConfigs(c);
        const t: ConfigTarget = c.wins === "package.json" ? "package.json" : "portless.json";
        setTarget(t);
        reset(c, t);
      },
      (err: unknown) => setLoadError(errorText(err)),
    );
  };
  useEffect(load, [api, place.dir]);

  const check = useMemo(() => checkConfigText(text), [text]);
  // A reviewed change is only good for the text it was made from.
  useEffect(() => setPreview(null), [text, target]);
  const formConfig: ProjectConfig = check.config ?? {};
  const source = configs ? (target === "portless.json" ? configs.portless : configs.package) : null;
  const original = source?.text ?? "";
  const dirty = text.trim() !== (original.trim() || "{}");

  const review = async () => {
    setBusy("preview");
    setError(null);
    try {
      setPreview(await api.portlessConfigPreview(place.dir, target, text));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const c = await api.portlessConfigSave(place.dir, target, text, source?.digest ?? "");
      setConfigs(c);
      reset(c, target);
      toast.info(`Saved ${target}. Restart the apps in this folder for portless to read it.`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "The file changed since Portplane read it. Reload to see the new version, then make your change again." : errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <ErrorState title="Couldn't read this folder's config" message={loadError} onRetry={load} />;
  if (!configs || !source) return <LoadingState label="Reading the config…" />;
  const both = configs.portless.exists && configs.package.hasConfig;

  return (
    <SettingsGroup
      title={shortenPath(place.dir, home)}
      description={
        <>
          {configs.wins ? (
            <>
              portless reads <span className="mono">{configs.wins}</span> here.
            </>
          ) : (
            <>No portless config here yet: portless names the app from {configs.packageName ? <span className="mono">{configs.packageName}</span> : "the folder"}.</>
          )}{" "}
          {both && "This folder also has a \"portless\" key in package.json, which portless ignores while portless.json exists."}
        </>
      }
    >
      <div className="config-switches">
        <Segmented<ConfigTarget>
          label="File"
          value={target}
          options={[
            { value: "portless.json", label: "portless.json" },
            { value: "package.json", label: "package.json “portless”" },
          ]}
          onChange={(t) => {
            setTarget(t);
            reset(configs, t);
          }}
        />
        <Segmented<"form" | "json">
          label="Editor"
          value={mode}
          options={[
            { value: "form", label: "Form" },
            { value: "json", label: "JSON" },
          ]}
          onChange={setMode}
        />
      </div>
      {target === "package.json" && !configs.package.exists ? (
        <p className="muted">This folder has no package.json.</p>
      ) : mode === "form" ? (
        check.config || !check.problems.length ? (
          <Form config={formConfig} onChange={(c) => setText(configText(c, extraKeys(text)))} />
        ) : (
          <p className="warn-text">The JSON has a problem the form can't show. Fix it in the JSON tab first.</p>
        )
      ) : (
        <textarea className="input mono config-json" value={text} rows={Math.min(24, Math.max(6, text.split("\n").length + 1))} spellCheck={false} aria-label={`${target} as JSON`} onChange={(e) => setText(e.target.value)} />
      )}
      {(check.problems.length > 0 || check.warnings.length > 0) && (
        <ul className="config-problems">
          {check.problems.map((p) => (
            <li key={p} className="field-error">
              {p}
            </li>
          ))}
          {check.warnings.map((w) => (
            <li key={w} className="warn-text">
              {w}
            </li>
          ))}
        </ul>
      )}
      {preview?.edit && dirty && (
        <div className="rename-diff">
          <FileDiff file={preview.edit} folder={place.dir} />
        </div>
      )}
      {preview && preview.problems.length > 0 && <p className="field-error">{preview.problems[0]}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="sgroup-foot">
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => reset(configs, target)}>
            Discard
          </button>
        )}
        {preview?.edit && dirty ? (
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!!busy || check.problems.length > 0} aria-busy={busy === "save" || undefined}>
            {busy === "save" && <Spinner />}
            Save {target}
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => void review()} disabled={!dirty || !!busy || check.problems.length > 0} aria-busy={busy === "preview" || undefined}>
            {busy === "preview" && <Spinner />}
            Review the change
          </button>
        )}
      </div>
      {place.apps.length > 0 && (
        <p className="field-hint">
          Used by{" "}
          {place.apps.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ", "}
              <a href={href(appRoute(machine, a.id, "url"))}>{a.label}</a>
            </span>
          ))}
          . portless reads the config when an app starts.
        </p>
      )}
    </SettingsGroup>
  );
}

function Places() {
  const { api } = useApp();
  const { ms } = useMachineScope();
  const [places, setPlaces] = useState<ConfigPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.portlessConfigs().then(
      (p) => {
        setPlaces(p);
        setSelected((s) => s ?? p[0]?.dir ?? null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  };
  useEffect(load, [api]);
  const home = inferHome(ms?.folders ?? []);
  if (error) return <ErrorState title="Couldn't look for portless config" message={error} onRetry={load} />;
  if (!places) return <LoadingState label="Looking for portless config…" />;
  if (!places.length) {
    return (
      <EmptyState icon="file" title="No project uses portless config"> An app that runs <code>portless run</code> reads <code>portless.json</code> (or package.json's <code>"portless"</code> key) in its folder; Portplane's own tasks name each app in their command instead.
      </EmptyState>
    );
  }
  const place = places.find((p) => p.dir === selected) ?? places[0];
  return (
    <>
      {places.length > 1 && (
        <div className="config-places" role="group" aria-label="Folders">
          {places.map((p) => (
            <button key={p.dir} type="button" className={`chip chip-btn${p.dir === place.dir ? " is-on" : ""}`} aria-pressed={p.dir === place.dir} onClick={() => setSelected(p.dir)}>
              <span className="mono">{shortenPath(p.dir, home)}</span>
              <span className="muted"> · {p.wins || "no config"}</span>
            </button>
          ))}
        </div>
      )}
      <Editor key={place.dir} place={place} home={home} />
    </>
  );
}

/** portless.json per project, as a form or as JSON (plan §5.5). */
export function ConfigSection() {
  return <StatusGate>{() => <Places />}</StatusGate>;
}
