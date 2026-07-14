/**
 * Design-system barrel. Phase-4b views import primitives from here:
 *
 *   import { Box, Button, EmptyState, Label, Markdown, DiffView } from "../../ui";
 *
 * A dense, GitHub-like kit on the `--*` token palette (light + dark). No
 * external fonts/CDNs — everything is self-hosted/bundled (CSP: 'self').
 */
export { Button, ButtonLink } from "./Button.tsx";
export type { ButtonVariant, ButtonSize } from "./Button.tsx";
export { IconButton } from "./IconButton.tsx";
export { Link, ExternalLink } from "./Link.tsx";
export { Box, BoxHeader, BoxRow, BoxFooter, Card } from "./Box.tsx";
export { UnderlineNav, Tabs } from "./UnderlineNav.tsx";
export type { UnderlineNavItem } from "./UnderlineNav.tsx";
export { Avatar } from "./Avatar.tsx";
export { Label, ColorLabel, StateLabel, VisibilityBadge } from "./Label.tsx";
export type { LabelTone } from "./Label.tsx";
export { Spinner, LoadingBlock } from "./Spinner.tsx";
export { EmptyState } from "./EmptyState.tsx";
export { Banner } from "./Banner.tsx";
export type { BannerTone } from "./Banner.tsx";
export { ToastHost } from "./ToastHost.tsx";
export { ConfirmDialogHost } from "./ConfirmDialogHost.tsx";
export { Dialog } from "./Dialog.tsx";
export { Menu } from "./Menu.tsx";
export type { MenuItem } from "./Menu.tsx";
export { Pagination } from "./Pagination.tsx";
export { RelativeTime } from "./RelativeTime.tsx";
export { Breadcrumb } from "./Breadcrumb.tsx";
export type { Crumb } from "./Breadcrumb.tsx";
export { Field, TextInput, Textarea, Select } from "./Fields.tsx";
export { Markdown } from "./Markdown.tsx";
export { CodeBlock, Mono, Sha } from "./Code.tsx";
export { DiffView, FileDiffView } from "./DiffView.tsx";

// Re-export the icon set + stores so views have one import surface.
export { Icons } from "../lib/Icons.tsx";
export { useToast } from "../store/toast.ts";
export { useConfirmDialog } from "../store/confirm.ts";
