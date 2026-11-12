// The documentation pages: copy buttons on code blocks and the current
// section highlighted in "On this page".
(function () {
  "use strict";

  document.querySelectorAll(".prose pre").forEach((pre) => {
    const box = document.createElement("div");
    box.className = "code";
    pre.replaceWith(box);
    box.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ""));
        btn.textContent = "Copied";
        btn.classList.add("done");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
      } catch (e) { /* clipboard blocked: the code stays selectable */ }
    });
    box.appendChild(btn);
  });

  const links = Array.from(document.querySelectorAll(".toc a"));
  const targets = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (!targets.length || !("IntersectionObserver" in window)) return;
  const visible = new Set();
  const mark = () => {
    // the first section on screen, or the last one scrolled past
    let current = targets.find((t) => visible.has(t));
    if (!current) current = targets.filter((t) => t.getBoundingClientRect().top < 100).pop();
    links.forEach((a) => a.classList.toggle("active", current && a.hash === "#" + current.id));
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)));
    mark();
  }, { rootMargin: "-72px 0px -60% 0px" });
  targets.forEach((t) => io.observe(t));
})();
