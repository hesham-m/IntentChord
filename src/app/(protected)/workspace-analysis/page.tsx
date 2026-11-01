import { redirect } from "next/navigation";

/**
 * Compatibility route only. Workspace Analysis is no longer a competing Owner journey;
 * Canonical Index + Context Mapping are integrated into the current governed Task surface.
 */
export default function Page() {
  redirect("/tasks/current");
}
