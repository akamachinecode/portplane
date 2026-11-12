import { useMemo } from "react";
import { encodeQr, qrPath } from "../../lib/qr";

/**
 * A QR code drawn in the page (lib/qr.ts): dark modules on a white card in
 * both themes, since phone cameras read dark on light best.
 */
export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(value, { ecc: "M" });
    } catch {
      return null;
    }
  }, [value]);
  if (!qr) return <p className="field-error">This address is too long for a QR code.</p>;
  const border = 4;
  const n = qr.size + border * 2;
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={qrPath(qr, border)} fill="#000000" />
    </svg>
  );
}
