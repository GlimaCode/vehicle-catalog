import React, { useState } from "react";
import VehicleSelector, { VehicleSelection } from "../VehicleSelector";
import { Badge } from "../ui";

export default function SelectorPage() {
  const [sel, setSel] = useState<VehicleSelection>({});
  return (
    <div>
      <h2>Cascading vehicle selector</h2>
      <p style={{ color: "var(--muted)", maxWidth: 860 }}>
        Reusable Make → Model → Sub-model → Year component (importable as{" "}
        <code>web/src/VehicleSelector.tsx</code> in future forms). Only valid combinations are
        selectable; changing an upstream field clears incompatible downstream selections.
        Review-required variant candidates are hidden unless explicitly toggled on.
      </p>
      <div className="panel">
        <VehicleSelector onChange={setSel} />
      </div>
      <div className="panel">
        <h3>Current selection</h3>
        <dl className="kv">
          <dt>Make</dt><dd>{sel.make?.standard_make ?? "—"}</dd>
          <dt>Model</dt><dd>{sel.model?.standard_model ?? "—"}{" "}
            {sel.model && <Badge value={sel.model.validation_status} />}</dd>
          <dt>Sub-model</dt><dd>{sel.submodel
            ? <>{sel.submodel.standard_submodel} <Badge value={sel.submodel.submodel_type} />{" "}
                <Badge value={sel.submodel.validation_status} /></>
            : "— (base model)"}</dd>
          <dt>Model year</dt><dd>{sel.year ?? "—"}</dd>
        </dl>
      </div>
    </div>
  );
}
