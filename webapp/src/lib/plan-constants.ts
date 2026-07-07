import {
    BarChart3,
    Newspaper,
    Gamepad2,
    Palette,
    Music,
    Video,
    Cloud,
    Shield,
    Zap,
    Star,
    Globe,
    Code,
    BookOpen,
    Camera,
    Rocket,
    Heart,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const MIN_END_TS_MARGIN_SECS = 120;

export const PLAN_ICONS = [
    { name: 'BarChart3', label: 'Finance', icon: BarChart3 },
    { name: 'Newspaper', label: 'News', icon: Newspaper },
    { name: 'Gamepad2', label: 'Gaming', icon: Gamepad2 },
    { name: 'Palette', label: 'Art/NFTs', icon: Palette },
    { name: 'Music', label: 'Music', icon: Music },
    { name: 'Video', label: 'Streaming', icon: Video },
    { name: 'Cloud', label: 'Cloud', icon: Cloud },
    { name: 'Shield', label: 'Security', icon: Shield },
    { name: 'Zap', label: 'Utilities', icon: Zap },
    { name: 'Star', label: 'Premium', icon: Star },
    { name: 'Globe', label: 'Web', icon: Globe },
    { name: 'Code', label: 'Dev Tools', icon: Code },
    { name: 'BookOpen', label: 'Education', icon: BookOpen },
    { name: 'Camera', label: 'Photo', icon: Camera },
    { name: 'Rocket', label: 'Startup', icon: Rocket },
    { name: 'Heart', label: 'Health', icon: Heart },
] as const;

export const ICON_MAP: Record<string, LucideIcon> = {
    BarChart3,
    Newspaper,
    Gamepad2,
    Palette,
    Music,
    Video,
    Cloud,
    Shield,
    Zap,
    Star,
    Globe,
    Code,
    BookOpen,
    Camera,
    Rocket,
    Heart,
};

export interface PlanMeta {
    n?: string;
    d?: string;
    i?: string;
    w?: string;
}

export function parsePlanMeta(metadataUri: string): PlanMeta {
    try {
        return JSON.parse(metadataUri);
    } catch {
        return {};
    }
}
