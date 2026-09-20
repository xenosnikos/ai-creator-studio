import { SettingsForm } from "@/components/SettingsForm";
import { settingsSnapshot } from "@/lib/settings-snapshot";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  // Read on the server and hand the form real values. The form used to fetch
  // this itself on mount, which meant a page showing nothing but a spinner if
  // that browser request never completed — and no way to see why.
  return <SettingsForm initial={settingsSnapshot()} />;
}
