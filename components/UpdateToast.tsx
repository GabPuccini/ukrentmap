"use client";

import { useEffect, useRef, useState } from "react";
import { BASE } from "@/lib/config";

/**
 * Registers the service worker (production builds only) and offers a reload
 * when a new version has downloaded. The new version never takes over a page
 * that is open; it waits until you tap Reload, or until the app is next started.
 */
export default function UpdateToast() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const userAsked = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    const onControllerChange = () => {
      if (userAsked.current) window.location.reload();
    };
    sw.addEventListener("controllerchange", onControllerChange);
    let reg: ServiceWorkerRegistration | undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") reg?.update().catch(() => {});
    };
    sw.register(`${BASE}/sw.js`, { scope: `${BASE}/` })
      .then((r) => {
        reg = r;
        if (r.waiting && sw.controller) setWaiting(r.waiting);
        r.addEventListener("updatefound", () => {
          const w = r.installing;
          w?.addEventListener("statechange", () => {
            if (w.state === "installed" && sw.controller) setWaiting(w);
          });
        });
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch((e) => console.warn("service worker:", e));
    return () => {
      sw.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!waiting) return null;
  return (
    <div className="toast" role="status">
      A new version is ready.
      <button
        onClick={() => {
          userAsked.current = true;
          waiting.postMessage("skip-waiting");
        }}
      >
        Reload
      </button>
    </div>
  );
}
