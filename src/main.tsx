import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import NightSky from "./NightSky.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NightSky />
    <App />
  </StrictMode>,
);
