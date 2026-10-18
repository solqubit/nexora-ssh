import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Nexora UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <span><AlertTriangle size={26} /></span>
        <h1>Nexora encontró un problema</h1>
        <p>{this.state.error.message || "La interfaz no pudo continuar de forma segura."}</p>
        <button className="button primary" onClick={() => window.location.reload()}><RefreshCw size={16} /> Reiniciar aplicación</button>
      </main>
    );
  }
}
