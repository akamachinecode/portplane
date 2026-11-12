// Fills the download lists, picks the right build for the visitor and wires
// the install tabs. The lists render at once from VERSION (kept in step by
// release-please), then the GitHub API fills in sizes and any newer release.
(function () {
  "use strict";
  const repo = "akamachinecode/portplane";
  const VERSION = "0.7.0"; // x-release-please-version

  // Every build of a release, in the order each card shows them. `name`
  // spells the file for a version; `match` finds it among the API's assets.
  const BUILDS = [
    { os: "darwin", arch: "arm64", group: "App", label: "Apple silicon", kind: "Disk image", ext: ".dmg", name: (v) => `portplane_${v}_darwin_arm64.dmg`, match: /_darwin_arm64\.dmg$/ },
    { os: "darwin", arch: "amd64", group: "App", label: "Intel", kind: "Disk image", ext: ".dmg", name: (v) => `portplane_${v}_darwin_amd64.dmg`, match: /_darwin_amd64\.dmg$/ },
    { os: "darwin", arch: "arm64", group: "Command line", label: "Apple silicon", kind: "Archive", ext: ".tar.gz", name: (v) => `portplane_${v}_darwin_arm64.tar.gz`, match: /_darwin_arm64\.tar\.gz$/ },
    { os: "darwin", arch: "amd64", group: "Command line", label: "Intel", kind: "Archive", ext: ".tar.gz", name: (v) => `portplane_${v}_darwin_amd64.tar.gz`, match: /_darwin_amd64\.tar\.gz$/ },
    { os: "linux", arch: "amd64", distro: "deb", group: "Debian, Ubuntu", label: "x86-64", kind: "Package", ext: ".deb", name: (v) => `portplane_${v}_amd64.deb`, match: /_amd64\.deb$/ },
    { os: "linux", arch: "arm64", distro: "deb", group: "Debian, Ubuntu", label: "ARM64", kind: "Package", ext: ".deb", name: (v) => `portplane_${v}_arm64.deb`, match: /_arm64\.deb$/ },
    { os: "linux", arch: "amd64", distro: "rpm", group: "Fedora, RHEL, openSUSE", label: "x86-64", kind: "Package", ext: ".rpm", name: (v) => `portplane-${v}-1.x86_64.rpm`, match: /\.x86_64\.rpm$/ },
    { os: "linux", arch: "arm64", distro: "rpm", group: "Fedora, RHEL, openSUSE", label: "ARM64", kind: "Package", ext: ".rpm", name: (v) => `portplane-${v}-1.aarch64.rpm`, match: /\.aarch64\.rpm$/ },
    { os: "linux", arch: "amd64", group: "Any distribution", label: "x86-64", kind: "Archive", ext: ".tar.gz", name: (v) => `portplane_${v}_linux_amd64.tar.gz`, match: /_linux_amd64\.tar\.gz$/ },
    { os: "linux", arch: "arm64", group: "Any distribution", label: "ARM64", kind: "Archive", ext: ".tar.gz", name: (v) => `portplane_${v}_linux_arm64.tar.gz`, match: /_linux_arm64\.tar\.gz$/ },
    { os: "windows", arch: "amd64", group: "App", label: "x64", kind: "Archive", ext: ".zip", name: (v) => `portplane_${v}_windows_amd64.zip`, match: /_windows_amd64\.zip$/ },
    { os: "windows", arch: "arm64", group: "App", label: "ARM64", kind: "Archive", ext: ".zip", name: (v) => `portplane_${v}_windows_arm64.zip`, match: /_windows_arm64\.zip$/ },
  ];
  const OS_NAMES = { darwin: "macOS", linux: "Linux", windows: "Windows" };
  const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0L4.5 6.5M8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---- what is the visitor on ----

  function detectOS() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return "";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return "darwin";
    if (/Linux|X11|CrOS/i.test(platform) || /Linux/i.test(ua)) return "linux";
    return "";
  }

  function detectDistro() {
    const ua = navigator.userAgent || "";
    if (/Fedora|Red Hat|CentOS|openSUSE|SUSE/i.test(ua)) return "rpm";
    if (/Ubuntu|Debian|Mint/i.test(ua)) return "deb";
    return "";
  }

  // Browsers hide the CPU. Chromium tells it on request; elsewhere the GPU's
  // name gives Apple silicon away ("Apple M2", "Apple GPU"). Unknown: arm64
  // on a Mac (most Macs sold since 2020), amd64 elsewhere.
  async function detectArch(os) {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
        if (v.architecture === "arm") return "arm64";
        if (v.architecture === "x86") return os === "darwin" ? gpuArch() || "amd64" : "amd64";
      }
    } catch (e) { /* not allowed: fall through */ }
    if (os === "darwin") return gpuArch() || "arm64";
    if (/aarch64|arm64/i.test(navigator.userAgent || "")) return "arm64";
    return "amd64";
  }

  function gpuArch() {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
      if (/Apple (M\d|GPU)/i.test(name)) return "arm64";
      if (/Intel|AMD|Radeon|NVIDIA/i.test(name)) return "amd64";
    } catch (e) { /* no WebGL */ }
    return "";
  }

  // ---- rendering ----

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  function size(bytes) {
    if (!bytes) return "";
    return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + " MB" : Math.round(bytes / 1e3) + " KB";
  }

  function downloadURL(tag, name) {
    return `https://github.com/${repo}/releases/download/${tag}/${name}`;
  }

  // release: { tag, version, assets: name -> {url, size} | null }
  function render(release, pick) {
    document.querySelectorAll(".platform").forEach((card) => {
      const os = card.dataset.os;
      const list = card.querySelector(".files");
      list.textContent = "";
      card.classList.toggle("mine", pick && pick.os === os);
      let group = "";
      for (const b of BUILDS.filter((x) => x.os === os)) {
        const file = resolve(release, b);
        if (!file) continue;
        if (b.group !== group) {
          group = b.group;
          list.appendChild(el("li", { class: "group" }, group));
        }
        const mine = pick && pick.build === b;
        const meta = [b.kind + " · " + b.ext, size(file.size)].filter(Boolean).join(" · ");
        const a = el("a", { class: "file" + (mine ? " recommended" : ""), href: file.url, download: "" },
          `<span class="what"><span class="label">${b.label}${mine ? ' <span class="badge">For this computer</span>' : ""}</span>` +
          `<span class="meta" title="${file.name}">${meta}</span></span><span class="get">${DOWNLOAD_ICON}</span>`);
        a.setAttribute("aria-label", `Download ${OS_NAMES[os]} ${b.label} ${b.ext}${file.size ? ", " + size(file.size) : ""}`);
        const li = el("li");
        li.appendChild(a);
        list.appendChild(li);
      }
    });
  }

  function resolve(release, b) {
    if (release.assets) {
      const name = Object.keys(release.assets).find((n) => b.match.test(n));
      return name ? { name, ...release.assets[name] } : null;
    }
    const name = b.name(release.version);
    return { name, url: downloadURL(release.tag, name), size: 0 };
  }

  function choose(os, arch, distro) {
    if (!os) return null;
    const own = BUILDS.filter((b) => b.os === os && b.arch === arch);
    // Linux without a known distribution: point at the card, not at a guess.
    if (os === "linux") return { os, arch, build: distro ? own.find((b) => b.distro === distro) || null : null };
    return own[0] ? { os, arch, build: own[0] } : null;
  }

  function renderHero(release, pick) {
    const link = document.getElementById("hero-download");
    const label = document.getElementById("hero-download-label");
    const note = document.getElementById("hero-download-note");
    if (!pick) return;
    const b = pick.build;
    if (!b) {
      link.href = "#download-linux";
      label.textContent = "Download for Linux";
      note.innerHTML = `v${release.version} for ${pick.arch === "arm64" ? "ARM64" : "x86-64"}: <code>.deb</code> for Debian and Ubuntu, <code>.rpm</code> for Fedora and openSUSE, or an archive for any distribution.`;
      return;
    }
    const file = resolve(release, b);
    if (!file) return;
    link.href = file.url;
    label.textContent = "Download for " + OS_NAMES[pick.os];
    const extra = { darwin: b.label + " · ", linux: b.label + " · ", windows: "Beta · " + b.label + " · " }[pick.os];
    note.innerHTML = `${extra}v${release.version} · <code>${b.ext}</code>${file.size ? " · " + size(file.size) : ""}. Not your computer? See <a href="#download-${pick.os === "darwin" ? "mac" : pick.os}">every build</a>.`;
  }

  function renderMeta(release) {
    const date = release.date ? new Date(release.date).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "";
    const notes = `https://github.com/${repo}/releases/tag/${release.tag}`;
    document.getElementById("release-meta").innerHTML =
      `Version ${release.version}${date ? ", released " + date : ""}. <a href="${notes}">What's new</a>`;
    const pill = document.getElementById("release-pill");
    pill.href = notes;
    document.getElementById("release-pill-text").textContent = `v${release.version} is out${date ? " · " + date : ""}`;
    document.getElementById("checksums").href = downloadURL(release.tag, "checksums.txt");
    document.getElementById("signature").href = downloadURL(release.tag, "checksums.txt.sigstore.json");
  }

  async function latest() {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(String(res.status));
    const rel = await res.json();
    const assets = {};
    for (const a of rel.assets || []) assets[a.name] = { url: a.browser_download_url, size: a.size };
    return { tag: rel.tag_name, version: rel.tag_name.replace(/^v/, ""), date: rel.published_at, assets };
  }

  // ---- install tabs and copy buttons ----

  function selectTab(name, focus) {
    document.querySelectorAll(".tabs button").forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    document.querySelectorAll(".cmd").forEach((p) => { p.hidden = p.dataset.tab !== name; });
  }

  function wireTabs(os) {
    const tabs = Array.from(document.querySelectorAll(".tabs button"));
    tabs.forEach((b, i) => {
      b.addEventListener("click", () => selectTab(b.dataset.tab));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        selectTab(next.dataset.tab, true);
      });
    });
    selectTab(os === "windows" ? "windows" : "unix");
    document.querySelectorAll(".copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.parentElement.querySelector("code").textContent;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "Copied";
          btn.classList.add("done");
          setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
        } catch (e) { /* clipboard blocked: the command stays selectable */ }
      });
    });
  }

  // ---- start ----

  async function main() {
    const os = detectOS();
    wireTabs(os);
    let release = { tag: "v" + VERSION, version: VERSION, date: "", assets: null };
    let pick = os ? choose(os, os === "darwin" ? "arm64" : "amd64", detectDistro()) : null;
    render(release, pick);
    renderHero(release, pick);

    const [arch, fresh] = await Promise.all([
      os ? detectArch(os) : Promise.resolve(""),
      latest().catch(() => null), // offline or rate-limited: keep VERSION's links
    ]);
    if (fresh) release = fresh;
    pick = os ? choose(os, arch, detectDistro()) : null;
    render(release, pick);
    renderHero(release, pick);
    renderMeta(release);
  }

  main();
})();
