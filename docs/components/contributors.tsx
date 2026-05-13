type GitHubContributor = {
  avatar_url: string;
  contributions: number;
  html_url: string;
  login: string;
};

async function getContributors(): Promise<GitHubContributor[]> {
  const response = await fetch('https://api.github.com/repos/solana-program/subscriptions/contributors', {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    next: {
      revalidate: 60 * 60 * 24,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch contributors: ${response.status}`);
  }

  return response.json();
}

export async function Contributors() {
  const contributors = await getContributors();

  return (
    <div className="not-prose mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {contributors.map((contributor) => (
        <a
          key={contributor.login}
          href={contributor.html_url}
          className="flex items-center gap-3 rounded-xl border bg-fd-card p-3 text-sm transition-colors hover:bg-fd-accent"
          target="_blank"
          rel="noreferrer"
        >
          <img
            src={contributor.avatar_url}
            alt={`${contributor.login} avatar`}
            className="h-10 w-10 rounded-full"
            loading="lazy"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">{contributor.login}</span>
            <span className="block text-xs text-fd-muted-foreground">
              {contributor.contributions} contributions
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
