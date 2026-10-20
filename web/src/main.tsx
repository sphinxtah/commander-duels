import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initInstall } from "./app/install";
import { registerServiceWorker } from "./app/serviceWorker";
import "./global.css";

// Before React renders: the browser's install offer can arrive as soon as the page loads.
initInstall();
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
