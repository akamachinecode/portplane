import { EmptyState } from "../../components/States";

/** portless doctor's findings, with fixes (plan §5.8, M5.2). */
export function DoctorSection() {
  return (
    <EmptyState icon="pulse" title="Doctor is coming">
      A later version runs portless doctor and offers a fix for each problem it finds.
    </EmptyState>
  );
}
