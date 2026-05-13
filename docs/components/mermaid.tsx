'use client';

import mermaid from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';

mermaid.initialize({
  securityLevel: 'strict',
  startOnLoad: false,
  theme: 'default',
});

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        setError(null);
        const { svg } = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to render diagram');
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-xl border bg-fd-muted p-4 text-sm text-fd-muted-foreground">
        {chart}
      </pre>
    );
  }

  return <div ref={ref} className="not-prose my-6 overflow-x-auto rounded-xl border bg-white p-4" />;
}
