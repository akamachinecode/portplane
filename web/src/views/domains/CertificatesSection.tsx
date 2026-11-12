import { EmptyState } from "../../components/States";

/** The local CA and who trusts it (plan §5.6, M5.2). */
export function CertificatesSection() {
  return (
    <EmptyState icon="file" title="Certificates are coming">
      portless serves HTTPS with its own local certificate authority. A later version shows whether your system and each browser trust it, and fixes it when they don't.
    </EmptyState>
  );
}
