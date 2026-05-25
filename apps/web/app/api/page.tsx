import { permanentRedirect } from "next/navigation";

export default function ApiDocsRedirect() {
  permanentRedirect("/about/api");
}
