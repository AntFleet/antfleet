import { permanentRedirect } from "next/navigation";

export default function PolicyRedirect() {
  permanentRedirect("/about/policy");
}
