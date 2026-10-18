import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VaultShell } from "./components/VaultShell";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary><VaultShell /></AppErrorBoundary>
  </StrictMode>,
);
