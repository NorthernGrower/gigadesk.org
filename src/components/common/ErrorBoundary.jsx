import React from 'react';

// A page that throws while rendering unmounts the whole app, which on a dark
// screen reads as a black page with nothing to say. This keeps the shell around
// it and shows the error instead, and the caller remounts it per route so moving
// to another page recovers on its own.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.log(`Page failed to render: ${(error && error.message) || error}`, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="surface space-y-3 p-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-destructive">This page failed to render</p>
        <p className="font-display text-sm font-semibold">
          {(this.state.error && this.state.error.message) || String(this.state.error)}
        </p>
        <p className="text-[11px] leading-snug text-muted-foreground">
          The rest of the desk still runs — the bot keeps managing open positions in the background. Open another page
          from the menu, or reload to try this one again.
        </p>
        <button
          type="button"
          className="rounded-lg border border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => this.setState({ error: null })}
        >
          Try this page again
        </button>
      </div>
    );
  }
}
