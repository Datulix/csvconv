interface PlaceholderProps {
  title: string;
  description: string;
  buildSteps: string;
}

export function Placeholder({ title, description, buildSteps }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="placeholder-meta">
        <span className="badge">not built yet</span>
        <span className="placeholder-hint">{buildSteps}</span>
      </div>
    </div>
  );
}
