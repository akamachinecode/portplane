// Picks the right download for the visitor and wires the install tabs.
(function () {
  "use strict";
  const repo = "akamachinecode/portplane";

  function detect() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return { os: "windows", tab: "windows" };
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return { os: "darwin", tab: "mac" };
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) return { os: "linux", tab: "linux" };
    return { os: "", tab: "mac" };
  }

  function selectTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.os === name)));
    document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.dataset.os !== name; });
  }

  async function pickDownload(os) {
    const link = document.getElementById("download");
    const note = document.getElementById("download-note");
    if (!os) return;
    try {
      const res = await fetch("https://api.github.com/repos/" + repo + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return;
      const rel = await res.json();
      const assets = rel.assets || [];
      // Apple silicon cannot be detected reliably from a browser: default to
      // arm64, the common case, and name the other build.
      const wanted = {
        darwin: [/_darwin_arm64\.dmg$/, /_darwin_arm64\.tar\.gz$/],
        linux: [/_linux_amd64\.tar\.gz$/],
        windows: [/_windows_amd64\.zip$/],
      }[os];
      for (const re of wanted) {
        const a = assets.find((x) => re.test(x.name));
        if (a) {
          link.href = a.browser_download_url;
          link.textContent = "Download " + rel.tag_name + " for " + { darwin: "macOS", linux: "Linux", windows: "Windows" }[os];
          note.textContent = os === "darwin"
            ? "For Apple silicon. Intel Macs: pick the amd64 build on the releases page."
            : "Other builds and checksums are on the releases page.";
          return;
        }
      }
    } catch (e) {
      /* offline or rate-limited: keep the link to the releases page */
    }
  }

  const d = detect();
  selectTab(d.tab);
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.os)));
  pickDownload(d.os);
})();
