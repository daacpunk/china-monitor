import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// Import for its side-effect: registers all Chart.js scales/elements
// (including TimeScale + the date adapter) before any chart mounts.
import "@/lib/charts";

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);
