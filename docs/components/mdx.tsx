import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Tab, Tabs as FumadocsTabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

type TabsProps = ComponentProps<typeof FumadocsTabs> & {
  groupId?: string;
  persist?: boolean;
};

function Tabs(props: TabsProps) {
  const isLanguageTabs = props.items?.some(item => item.toLowerCase() === 'typescript') &&
    props.items?.some(item => item.toLowerCase() === 'rust');

  if (!isLanguageTabs) return <FumadocsTabs {...props} />;

  return <FumadocsTabs groupId="preferred-language" persist {...props} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tab,
    Tabs,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
