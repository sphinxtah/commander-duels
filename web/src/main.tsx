import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initInstall } from "./app/install";
import { lockScrollUnderModals } from "./app/scrollLock";
import { registerServiceWorker } from "./app/serviceWorker";
// Cinzel (SIL Open Font License), served from the site itself: titles and buttons (v0.4.5).
import "@fontsource-variable/cinzel";
import "./global.css";

// Before React renders: the browser's install offer can arrive as soon as the page loads.
initInstall();
registerServiceWorker();
// Pop-ups lock the page behind them (v0.7.2): one watcher for every dialog the app opens.
lockScrollUnderModals();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
