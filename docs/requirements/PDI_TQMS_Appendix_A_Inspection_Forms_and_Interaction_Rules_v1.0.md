# PDI TQMS — Appendix A: Receiving Inspection Forms and Interaction Rules
**Release:** 17 October 2026 | **Classification:** Clean-sheet business-content specification | **Companion to:** PDI TQMS Functional Requirements v1.0

## A1. Design and interpretation requirements
This catalogue specifies the desired inspection form families, characteristic wording, conditional measurement sections, input scales and interaction behavior. It is business content, not a software schema or UI code. Preserve the operationally distinctive structure while choosing an implementation independently. Values marked **Not supplied** are intentionally unresolved technical acceptance limits; do not invent specifications or mark parts conforming without an authorized limit. An appointed PDI owner must validate form texts and revisions before production release.

**Common inspection launch:** Type-ahead Company Part Number, description, form selector, 1–100 inspected items, PO, received date, inspector default; identify supplier/site and lot/sampling where relevant. An inspection contains one common receiving section and a tab for each inspected unit, each with serial, visual/measured characteristic responses, per-question evidence, and final disposition. Use P/F/A on most visual rows; P/F/A/N on common receiving. A failed or accepted visual/receiving row requires observation and directly attached image; enforce this on completion. Pass All confirms overwrite; no free pass for unmet measurements. Provide sticky header, immediate save status, Save / Partial / Complete / PDF / Close, Prev/Next item navigation. Derived worst-case overall outcome: FAIL > ACCEPTED > PASS. Accept is a deviation requiring explicit authority, not a passing inspection. All completed records retain frozen question and requirement editions.**

## A2. Standard question/section patterns
### Pfn Checklist — Checklist — characteristic with acceptance criterion
**Columns:** #, Inspection Item, Description (acceptance criterion), Finding / Observation, Status, Image.
**Conditional evidence:** Finding / Observation when Status is F or A ("Description required" shown immediately). At least one image on the row when Status is F or A (checked at completion; the image control pulses red).

### Pass Fail Checklist — Checklist — characteristic with acceptance criterion shown under the name
**Columns:** #, Inspection Item (name + criterion), Finding / Observation (notes), Status, Image.
**Conditional evidence:** Notes when Status is F or A. At least one image on the row when Status is F or A (checked at completion).

### Pfn Visual — Visual CTQ checklist (CTQ Area, Failure Mode, Acceptance Criteria, Method, Result, Remarks)
**Columns:** #, CTQ Area, Failure Mode, Acceptance Criteria, Method, Result, Remarks, Image.
**Conditional evidence:** Remarks when Result is A.

### Dimensional — Measurement table — up to three readings per characteristic
**Columns:** #, Measurement, Location(s), Spec / Limit, Actual 1, Actual 2, Actual 3, Status, Notes, Image, Tools (remove row).
**Conditional evidence:** Notes when Status is A. Images optional; the image control is flagged when Status is F or A, but completion does not check images for this section type.
**Computed:** None. Readings are not compared with the specification; the inspector chooses the status.

### General Measurements — Measurement table — one reading per characteristic
**Columns:** #, Measurement, Specification, Actual Value, Notes, Result, Image, Tools (remove row).
**Conditional evidence:** Notes when Result is A.
**Computed:** None (manual result).

### Camshaft Bore — Bore series — one specification, N bore readings, one result
**Columns:** .
**Conditional evidence:** Notes when Result is A.
**Computed:** None.

### Fire Ring Protrusion — Cylinder series — one specification, one reading per cylinder, one result
**Columns:** .
**Conditional evidence:** Notes when Result is A.
**Computed:** None.

### Groove Specs — Fire Ring — specification header plus a per-cylinder chart for each specification flagged for entry
**Columns:** .
**Conditional evidence:** Notes when Status is A.
**Computed:** None. Specifications are shown as reference text; readings are not compared.

### Valve Recession — Valve recession — intake and exhaust limits, four valve readings per cylinder, result per cylinder
**Columns:** .
**Computed:** None. Limits are recorded but readings are not compared with them (observed: 0.95 against 0.10–0.20 raised no flag, WT-11).

### Vacuum Test — Vacuum test — result per cylinder with conditional valve sub-results
**Columns:** .
**Conditional evidence:** Notes when the cylinder result is Accepted.
**Computed:** "All Pass" sets every cylinder to Pass.

## A3. Inspection form catalogue and detailed characteristic definitions
The active catalogue forms are available for new inspections. Superseded/inactive definitions remain readable for historical traceability but are not used for new work. Each named characteristic below is a separate inspector-answerable row unless the section defines a special measurement table or cylinder series. The exact limits for supplier/product-specific dimensions shall resolve from an authorized technical baseline where available.

**Catalogued definitions:** 31 total; 28 selectable active forms. Historical/inactive forms are explicitly labeled.

### PDI-IQI-001 — Piston
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Crown / Combustion Bowl; Acceptance: Zero cracks, porosity, or cold-shuts on crown face and bowl rim; surface as-cast/machined with no heat discoloration
- Ring Grooves; Acceptance: Groove sidewalls parallel and square as-machined; edges sharp, free of burrs, nicks, or machining tears; no debris in grooves
- Piston Skirt Coating; Acceptance: Friction-reducing coating 100% intact; zero bare metal patches, flaking, or handling abrasion on skirt surface
- Pin Bore; Acceptance: Bore surface smooth and as-machined; no corrosion from transit or storage; finish within drawing Ra specification
- Oil Drain Passages; Acceptance: All drain holes and slots clear of swarf, sealant, and preservative; verified with compressed-air probe
- Part Identification Marking; Acceptance: Part number engraved or laser-marked on part body; permanent and legible; matches purchase order
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Skirt OD; Location: 90° to pin axis, 15 mm from skirt bottom; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Pin Bore Diameter; Location: Center of bore — 0° and 90° axes; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Ring Groove Width — Top Compression (No. 1); Location: 3 pts at 120° intervals; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Ring Groove Width — Oil Control (No. 3); Location: 3 pts at 120° intervals; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Abutment Face Flatness (two-piece only); Location: 4 pts across abutment mating face; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-002 — Cylinder Liner
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Bore Surface — Cracks; Acceptance: Zero cracks anywhere on bore surface; any crack indication = immediate rejection
- Bore Honing Pattern; Acceptance: Cross-hatch present, uniform, and undamaged as-machined; angle 25–35°; no burnished or polished areas from machining error; no smearing or torn metal from mishandling
- O-Ring Groove; Acceptance: Groove walls sharp and smooth as-machined; no burrs, nicks, or pitting; free of all preservative and debris
- Flange Seating Face; Acceptance: Seating face flat and undamaged as-machined; no cracks, chips, or impact marks from handling
- Part Identification Marking; Acceptance: Part number and size code permanently marked and legible; matches purchase order
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Bore Diameter; Location: Top / mid / bottom — 2 axes 90° at each plane (6 total readings); Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Bore Out-of-Round; Location: Max - min reading within each cross-sectional plane; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Bore Taper; Location: Top bore diameter minus bottom bore diameter; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Flange Thickness; Location: 4 pts at 90° intervals around flange; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-003 — Piston Pin
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- OD Surface — Spalling / Flaking; Acceptance: OD surface mirror-smooth as ground; zero spalling, flaking, or pitting of any size — immediate rejection
- OD Surface — Scoring; Acceptance: No longitudinal scratch marks or galling; surface as-manufactured with no handling damage
- Straightness; Acceptance: No visible bow; max 0.013 mm deviation on V-block surface-plate check
- Snap Ring Groove / End Faces; Acceptance: Groove edges sharp and undamaged as-machined; end faces free of burrs and handling nicks
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Pin OD; Location: Center + 25 mm from each end — 0° and 90° axes (6 total readings); Numerical acceptance limit: Not supplied; resolve to authorized product specification
- OD Taper; Location: Center reading minus end reading; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- OD Out-of-Round; Location: Max - min at any single cross-section; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Overall Length; Location: Parallel to pin axis; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-004 — Piston Ring
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Running Face Coating; Acceptance: Coating 100% intact and uniform; zero flaking, chipping, or bare patches of any size
- Gap End Faces; Acceptance: End faces square, smooth, and as-manufactured; no chips, burrs, or deformation at gap ends
- Orientation Mark; Acceptance: 'TOP', dot, or pip mark present on all rings, clearly legible; per approved specification
- Ring Body; Acceptance: Ring body flat with no visible twist, kink, or corrosion; free of storage damage and preservative residue
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Free End Gap (relaxed); Location: Ring uncompressed; measure gap opening with calipers or feeler gauge; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Installed End Gap; Location: Ring squared in calibrated reference bore at 25 mm depth; feeler gauge; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Axial Width (ring height); Location: Micrometer at 3 pts 120° apart on ring body; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Radial Wall Thickness; Location: Micrometer at 3 pts 120° apart; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-005 Rev A — Cylinder Head
**Availability:** Historical/inactive or hidden reference.
**A. VISUAL INSPECTION** — pass fail checklist; once per item.
- Check for visible cracks, casting voids, or porosity
- Inspect all machined surfaces for finish quality and damage
- Verify proper placement of all casting identification marks
- Ensure no rust, oxidation, or excessive contaminants
- Confirm correct thread condition on all bolt holes
**B. PORT & GALLEY INSPECTION** — pass fail checklist; once per item.
- Inspect intake ports for proper casting and machining
- Inspect exhaust ports for proper casting and machining
- Check coolant galleries for cleanliness
- Check oil galleries for cleanliness
- Confirm oil drain passages are properly sized and free from flaws
**C. INJECTOR BORE INSPECTION** — pass fail checklist; once per item.
- Verify that injector bores are properly machined
- Ensure injector cups are installed correctly
- Check for o-rings in injector bores and ensure proper fitment
- Inspect sealing surfaces for machining issues
**D. VALVETRAIN INSPECTION** — pass fail checklist; once per item.
- Inspect valve springs for visible damage, corrosion, or uneven seating
- Check spring seats/retainers for cracks, wear, or improper installation
- Verify valve stem seals are properly seated and free from visible damage
- Inspect valve stems for proper alignment — check for bent or misaligned valves
- Confirm all valve keepers are fully engaged and properly seated
**E. PACKAGING** — pass fail checklist; once per item.
- Verify proper rust prevention measures applied
- Ensure packaging prevents shipping damage
- All required documentation included
- Shipping labels correct and legible
**F. GENERAL MEASUREMENTS** — general measurements; once per item; **optional/conditional**.
- Cylinder Head Height
- Surface Finish (Ra)
- Flatness
- Valve Stem Height
**G. CAMSHAFT BORE DIMENSION** — camshaft bore; once per item; **optional/conditional**.
  - Enter pattern-specific results (bore count=7), with applicability and acceptance rules provided by the controlled inspection plan.
**H. FIRE RING PROTRUSION** — fire ring protrusion; once per item; **optional/conditional**.
  - Enter pattern-specific results (cylinder count=6), with applicability and acceptance rules provided by the controlled inspection plan.
**I. VALVE RECESSION** — valve recession; once per item; **optional/conditional**.
  - Enter pattern-specific results (cylinder count=6, intake count=2, exhaust count=2), with applicability and acceptance rules provided by the controlled inspection plan.
**J. VACUUM TEST** — vacuum test; once per item; **optional/conditional**.
  - Enter pattern-specific results (cylinder count=6, intake count=2, exhaust count=2), with applicability and acceptance rules provided by the controlled inspection plan.

### PDI-IQI-005 Rev B — Cylinder Head
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pfn checklist; once per item.
- Oxidation / Markings; Acceptance: Should be free of rust, pitting, or other material oxidation
- Edge Debur; Acceptance: Check machined edges for sharp edges
- Block-off Plugs; Acceptance: Confirm all required plugs are in place and torqued to spec
- Heat Tab; Acceptance: Confirm Heat Tab in installed appropriately
- Casting Quality; Acceptance: Using bore-scope verify casting quality in all intake and exhaust ports
- Finish; Acceptance: Confirm machining finish and casting quality
- Machining Quality; Acceptance: Verify machining quality in all intake and exhaust ports if applicable
- Material Type; Acceptance: Confirm injector cup material type
- Pass-through bore (Cummins); Acceptance: Confirm pass through tube fits bore
- Correct Valves; Acceptance: Confirm intake/exhaust in correct locations
- Springs / Retainers / Keepers; Acceptance: Confirm correct spring assemblies and everything assembled properly
**C. DIMENSIONAL INSPECTION — General** — general measurements; once per item; **optional/conditional**.
- Cylinder Head Height
- Surface Finish (Ra)
- Flatness
- Valve Stem Height
**C. DIMENSIONAL INSPECTION — Fire Ring** — groove specs; once per item; **optional/conditional**.
- Groove Diameter; Specification: 6.300" Groove OD for CAT, 5.990" Groove OD for Cummins; Unit: inch (")
- Groove Depth; Specification: .029-.031"; Unit: inch (")
- Wire Protrusion; Specification: .008-.010"; Unit: inch (")
**C. DIMENSIONAL INSPECTION — Valve Recession** — valve recession; once per item; **optional/conditional**.
  - Enter pattern-specific results (cylinder count=6, intake count=2, exhaust count=2), with applicability and acceptance rules provided by the controlled inspection plan.
**C. DIMENSIONAL INSPECTION — Vacuum Test** — vacuum test; once per item; **optional/conditional**.
  - Enter pattern-specific results (cylinder count=6, intake count=2, exhaust count=2), with applicability and acceptance rules provided by the controlled inspection plan.

### PDI-IQI-006 — Cylinder Head
**Availability:** Historical/inactive or hidden reference.
**GENERAL MEASUREMENTS** — general measurements; once per item.
- Cylinder Head Height
- Surface Finish (Ra)
- Flatness
- Valve Stem Height
**CAMSHAFT BORE DIMENSION** — camshaft bore; once per item.
  - Enter pattern-specific results (bore count=7), with applicability and acceptance rules provided by the controlled inspection plan.
**FIRE RING PROTRUSION** — fire ring protrusion; once per item.
  - Enter pattern-specific results (cylinder count=6), with applicability and acceptance rules provided by the controlled inspection plan.
**VALVE RECESSION** — valve recession; once per item.
  - Enter pattern-specific results (), with applicability and acceptance rules provided by the controlled inspection plan.
**VACUUM TEST** — vacuum test; once per item.
  - Enter pattern-specific results (cylinder count=6, intake count=2, exhaust count=2), with applicability and acceptance rules provided by the controlled inspection plan.

### PDI-IQI-007 — Camshaft
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Cam Lobes; Acceptance: Cam lobes are free from chips, dents, scratches, scoring, pitting, rust, or discoloration.
- Bearing Journals; Acceptance: Bearing journals have a smooth, uniform finish with no nicks, bruising, or corrosion.
- Thrust Faces; Acceptance: Thrust faces are clean and undamaged, with no burrs or gouges.
- Gear / Keyway / Timing Features; Acceptance: Gear, keyway, dowel, or timing-feature areas are free from cracks, chips, and burrs.
- Oil Passages; Acceptance: Oil holes/passages visible from the outside are open and free from burrs, metal chips, or debris.
- Shaft Straightness; Acceptance: Shaft is visually straight with no obvious bending or handling damage.
- Edges & Machined Transitions; Acceptance: Edges and machined transitions are clean, with no sharp burrs or loose material.
- Surface Cleanliness; Acceptance: Overall surface is free from contamination such as dirt, grinding residue, preservative buildup, or foreign material.

### PDI-IQI-008 — Radiator
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Cooling Fins; Acceptance: Cooling fins are straight, evenly spaced, and not crushed, folded, torn, or missing.
- Tubes; Acceptance: Tubes are free from dents, punctures, cracks, or visible deformation.
- Header Plates & Tank Joints; Acceptance: Header plates and tank-to-core joints show uniform brazing/crimping with no gaps, cracks, or separation.
- Tanks; Acceptance: Tanks are free from cracks, dents, warping, or molding/casting defects.
- Inlet & Outlet Necks; Acceptance: Inlet and outlet necks are round, clean, and free from dents, cracks, burrs, or deformation.
- Mounting Brackets & Frames; Acceptance: Mounting brackets, side plates, and support frames are not bent, cracked, or loose.
- Core Alignment; Acceptance: Core is visually square and not twisted, bowed, or misaligned.
- Surface Cleanliness; Acceptance: External surfaces are free from corrosion, loose flux, debris, oil, or other contamination.

### PDI-IQI-009 — Clutch
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Friction Facings; Acceptance: Friction facings are clean and free from cracks, chips, glazing, oil, grease, or foreign material.
- Rivets & Fasteners; Acceptance: Rivets or fasteners are fully seated and show no looseness, distortion, or damage.
- Hub Splines; Acceptance: Hub splines are clean and free from burrs, dents, corrosion, or damaged teeth.
- Damper Springs; Acceptance: Damper springs are correctly seated, intact, and not cracked, broken, or displaced.
- Pressure Plate Surface; Acceptance: Pressure plate contact surface is smooth and free from scratches, scoring, rust, dents, or contamination.
- Diaphragm Fingers; Acceptance: Diaphragm fingers or release levers are uniform in position and not bent, cracked, or damaged.
- Clutch Cover / Housing; Acceptance: Clutch cover/housing is free from cracks, dents, distortion, or damaged mounting holes.
- Edges & Machined Surfaces; Acceptance: Edges, stamped areas, and machined surfaces are free from loose burrs, sharp damage, or metal debris.

### PDI-IQI-010 — Oil Cooler
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Cooling Fins / Core; Acceptance: Cooling fins, plates, or core surfaces are straight and free from crushed, torn, or missing sections.
- Body Integrity; Acceptance: Tubes, plates, or cooler body are free from dents, cracks, punctures, or deformation.
- Brazed / Welded Joints; Acceptance: Brazed, welded, or bonded joints appear continuous with no visible gaps, cracks, voids, or separation.
- Oil & Coolant Ports; Acceptance: Oil and coolant ports are clean, round, and free from burrs, dents, thread damage, or contamination.
- Sealing Faces; Acceptance: Sealing faces are smooth and free from scratches, gouges, corrosion, or embedded debris.
- Mounting Tabs & Brackets; Acceptance: Mounting tabs, brackets, and bosses are intact and not cracked, bent, or broken.
- Exterior Surfaces; Acceptance: Exterior surfaces are free from rust, oxidation, loose scale, oil residue, or foreign material.
- Internal Port Areas; Acceptance: Visible internal port areas are free from metal chips, casting sand, loose particles, or blockage.

### PDI-IQI-011 — Turbocharger
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Compressor Wheel Blades; Acceptance: Compressor wheel blades are free from chips, cracks, bends, nicks, or foreign-object damage.
- Turbine Wheel Blades; Acceptance: Turbine wheel blades are free from cracks, missing material, bends, or visible impact damage.
- Compressor & Turbine Housings; Acceptance: Compressor and turbine housings are free from cracks, dents, casting defects, or broken flanges.
- Inlet & Outlet Openings; Acceptance: Inlet and outlet openings are clean and free from debris, metal chips, or loose material.
- Mounting Flanges; Acceptance: Mounting flanges and gasket faces are smooth and free from scratches, gouges, dents, or corrosion.
- Studs & Threaded Holes; Acceptance: Studs, threaded holes, and fastener areas are visually undamaged and free from burrs or deformation.
- Actuator & Wastegate; Acceptance: Actuator, linkage, and wastegate/VGT external components are intact, correctly seated, and not bent or damaged.
- Oil & Coolant Connections; Acceptance: Oil and coolant connection areas are clean and free from cracks, damaged threads, or sealing-surface defects.

### PDI-IQI-012 — Fuel Injector
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Injector Body; Acceptance: Injector body is free from cracks, dents, corrosion, scratches, or handling damage.
- Nozzle Tip; Acceptance: Nozzle tip is clean and free from dents, cracks, burrs, contamination, or blocked visible spray holes.
- Sealing Cone / Seat; Acceptance: Sealing cone, seat, or sealing washer contact areas are smooth and free from gouges, nicks, or debris.
- Threads & Fuel Ports; Acceptance: Threads and fuel connection ports are clean and free from burrs, dents, cross-threading, or deformation.
- Electrical Connector; Acceptance: Electrical connector body and pins, if applicable, are straight, clean, intact, and free from cracks or bent terminals.
- O-Rings & Seals; Acceptance: O-rings, seals, or visible sealing elements are present, seated correctly, and free from cuts, twists, flattening, or contamination.
- Filter Screen / Inlet; Acceptance: Filter screen or inlet area, where visible, is clean and free from metal chips, dirt, or obstruction.
- External Surfaces; Acceptance: External surfaces show no oil, grease, rust, preservative buildup, or foreign material that could affect installation or cleanliness.

### PDI-IQI-013 — Cylinder Block
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Casting & Fire Deck Integrity; Acceptance: Zero visible cracks, porosity, cold-shuts, or inclusions on the top deck face, water jackets, or exterior crankcase structures.
- Liner Seats & Packing Grooves; Acceptance: Machined liner counterbore steps and lower O-ring packing grooves are sharp and free of fretting, scoring, rust, or residual machining steps.
- Main Bearing Saddles & Caps; Acceptance: Cap-to-block mating serrations or flat locator surfaces are completely clean, unbruised, and free of nicks or handling damage.
- Thread & Tap Condition; Acceptance: All cylinder head bolt holes, main cap bolt holes, and auxiliary oil gallery tapped threads are clean, fully formed, and free of cross-threading or trapped metal swarf.
- Oil & Coolant Galleries; Acceptance: All internal oil cross-drillings and cooling passages are completely unobstructed; verified free of residual casting sand, scale, or machining chips.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Liner Counterbore Depth; Location: Measured at 4 points (90° intervals) around the perimeter of each cylinder liner seating step.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Main Bearing Bore Diameter; Location: Across all main journals with caps installed and torqued to specification (0° and 90° vertical/horizontal axes).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Block Deck Flatness; Location: Precision straight-edge and feeler gauge checks along longitudinal, transverse, and diagonal axes of the cylinder head mating face.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Camshaft Bore Diameter; Location: Inside diameter check at all internal cam tunnel bearing positions (0° and 90° axes).; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-014 — Crankshaft
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Journal Surface Finish; Acceptance: All main and connecting rod journals ground to a mirror finish; zero evidence of linear scoring, micro-pitting, transit scratches, or heat discoloration.
- Fillet Radii Transitions; Acceptance: Journal fillet radii are perfectly smooth and continuous; free of machining steps, grinding burn marks, or sharp undercut transitions.
- Oil Holes & Chamfers; Acceptance: Lubrication cross-holes are fully open and deburred; chamfered edges are smooth with zero loose grinding fins or trapped debris inside the oil pathways.
- Keyways, Splines & Snout; Acceptance: Front snout keyways, timing gear press-fit areas, and rear flange bolt holes are crisp, clean, and free of burrs or rolled-over metal edges.
- Thrust Face Alignment; Acceptance: Machined thrust walls adjacent to the indexing main journal are clean and free of grinding tears or handling nicks.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Main Journal Outer Diameter (OD); Location: At the front, center, and rear sections of each main journal across 0° and 90° axes.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Crankpin / Rod Journal Outer Diameter (OD); Location: At the center section of each rod journal across 0° and 90° axes.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Journal Taper & Out-of-Round; Location: Calculated max-to-min diameter difference across the width and circumference of each individual journal.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Total Indicator Runout (Crankshaft Straightness); Location: Supported on V-blocks at the front and rear main journals; dial indicator on the center main journal through a 360° rotation.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-015 — Dampener
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Housing & Seal Integrity (Viscous Type); Acceptance: Laser-welded or crimped housing is continuous and completely sealed; zero evidence of silicone fluid weeping, exterior dents, or housing bulges.
- Elastomer Element (Rubber Type); Acceptance: Bonded rubber strip is fully intact; zero cracking, separation from metal rings, dry-rot pits, or extrusion gaps between the hub and inertia ring.
- Indexing & Timing Marks; Acceptance: Top Dead Center (TDC) and degree alignment marks are permanently stamped, clean, legible, and unmarred.
- Mounting Flange Face; Acceptance: Crankshaft snout mounting surface and bolt holes are flat and free of burrs, paint overspray, rust, or impact nicks.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Crankshaft Pilot Bore Inner Diameter (ID); Location: Inside diameter of the center registration hub bore (measured across 2 perpendicular axes).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Mounting Flange Thickness; Location: At 4 equidistant points around the bolt circle flange layout.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Radial and Axial Runout (TIR); Location: Mounted to a true test arbor; dial indicator tracked on the outermost perimeter face and front lateral face through a full rotation.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-016 — Exhaust Manifold Spacer
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Sealing Flange Surface Finish; Acceptance: Machined gasket seating faces are smooth and uniform; zero deep scratches, pitting, casting voids, or transport gouges.
- Gas Passage Profiles; Acceptance: Internal exhaust gas path is completely free of casting fins, flash, metal inclusions, or loose scale that could disrupt gas flow.
- Fastener Clearance Holes; Acceptance: Through-bolt holes are clean, round, and free of edge crushing, burrs, or drilling exit steps.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Overall Thickness; Location: With a micrometer at all 4 corners/edges of the spacer block.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Parallelism; Location: Maximum thickness variation calculated between all measured points on the parallel seating planes.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Flange Face Flatness; Location: Across the sealing planes using a precision surface plate layout or a knife-edge straight-edge.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-017 — Piston Oiler
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Tube Alignment & Nozzle Shape; Acceptance: Oiler target tubes are perfectly formed and visually straight; zero crimps, handling kinks, flattening, or tool indentation marks along the thin-wall tubing.
- Braze / Weld Joint Integrity; Acceptance: Brazed or welded joints anchoring the target tubes to the mounting banjo base block are continuous, uniform, and free of pinholes or cracking.
- Jet Discharge Orifice; Acceptance: The final fluid exit orifice is perfectly round, crisp, and 100% free of internal swarf, burrs, or storage preservative blockage.
- Locating Dowel Pin / Tab; Acceptance: The alignment pin or anti-rotation tab on the mounting base is unbent, rigid, and completely free of casting or stamping defects.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Nozzle Jet Tip Orifice Diameter; Location: Internal diameter verification at the tube exit tip using a calibrated Go/No-Go pin gauge.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Banjo Base Mounting Inner Diameter (ID); Location: Inside diameter of the bolt fastening bore (2 axes at 90°).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Nozzle Tip Protrusion Height & Offset; Location: Via a height gauge fixture from the flat mounting base face to the center point of the nozzle tip orifice.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-018 — Piston Oiler Bolt
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Thread Roll Quality; Acceptance: Threads are fully formed, clean, and uniform; zero flat spots, rolling nicks, crest tearing, or cross-threaded areas.
- Fluid Feed Ports; Acceptance: Cross-drilled fluid passages and the central axial feed hole are entirely open; free of drilling burrs, loose flakes, or residual metal shavings.
- Internal Check Valve Mechanical Freedom; Acceptance: Internal spring-loaded ball or plunger moves smoothly when depressed with a brass test probe; snaps back securely into its seat with no binding or sticking.
- Under-Head Sealing Shoulder; Acceptance: The flat shoulder face that contacts the oiler block/crush washer is entirely free of radial scratches, burrs, or machining spirals.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Major Thread Diameter & Pitch; Location: Thread section check using a micrometer and thread pitch ring gauge.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Under-Head Shank Length; Location: From the flat bearing shoulder to the absolute end of the bolt shank.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Cross-Drilled Port Diameter; Location: Inside diameter verification of fluid escape cross-holes via pin gauges.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-019 — Rocker Shaft
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Journal Seating Surface Finish; Acceptance: Centerless-ground shaft OD at all rocker arm journal locations must be mirror-smooth; zero scoring, ridges, pitting, handling bruises, or chrome-plating flaking.
- Oil Distribution Passages; Acceptance: All radial oil supply feed holes are smoothly deburred and radiused; internal oil tunnel is clear of honing residue or factory debris.
- End-Plug Sealing; Acceptance: Pressed-in or welded end retention plugs are tight, seated flush, and show zero micro-cracks or loose fitment.
- Mounting Pedestal Bosses; Acceptance: Flat relief cuts or mounting notches for hold-down bolts are free of sharp burrs or alignment distortion.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Shaft Outer Diameter (OD); Location: At each separate rocker arm journal position along 2 axes spaced 90° apart.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Shaft Straightness; Location: Total Indicator Runout (TIR) along the center span of the shaft while supported on V-blocks at both ends.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Pedestal Mount Bolt Hole Location; Location: Center-to-center pitch distance checked between all adjacent hold-down bolt paths.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-020 — Connecting Rod Bearing
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Antifriction Lining Overlay; Acceptance: The interior bearing lining surface is 100% flawless and uniform; zero scratches, scuffs, layer blistering, exposed mid-layers, or embedded foreign matter.
- Steel Backing Condition; Acceptance: The rear steel shell face is smooth, clean, and uniform; zero rust stains, pitting, fretting shadows, or deep stamping indentations.
- Locating Tangs & Parting Lines; Acceptance: Anti-rotation locating tangs are sharp, crisp, and completely unbent; parting line mating faces are flat and free of upset metal or handling burrs.
- Oil Grooves & Holes; Acceptance: Oil supply channels and cross-holes are cleanly punched/machined with smoothly chamfered edges; no loose backing burrs.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Bearing Shell Wall Thickness; Location: At the exact center apex of the bearing half using a specialized ball-anvil micrometer.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Overall Shell Width; Location: Parallel to the bearing centerline across the parting line edges.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Bearing Free Spread; Location: Distance across the extreme outer tips of the bearing shell parting lines in its relaxed state.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-021 — Spacer Plate
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Sealing Face Flatness & Finish; Acceptance: Parallel sealing faces are flat and uniform; zero scratches, deep handling gouges, corrosion pits, or distorted areas caused by improper wire-wheel cleanup.
- Inner & Outer Edge Cleanliness; Acceptance: Cylinder liner bore cutouts and outer perimeter profiles are clean-stamped/machined; completely free of heavy dross, hanging burrs, or edge distortions.
- Transfer Passages; Acceptance: All stamped water-jacket holes, oil pressure feeds, and pushrod passages are fully formed, clear, and perfectly aligned with no obstruction or restricted corners.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Plate Thickness; Location: With a micrometer at 6 standardized locations across the plate perimeter layout (ends and center bridges).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Parallelism (Thickness Variation); Location: Calculated total difference between maximum and minimum thickness readings across the entire plate body.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Cylinder Liner Cutout Inner Diameter (ID); Location: Across 2 perpendicular axes at each cylinder opening loop.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-022 — Thermostat
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Housing Frame & Valve Seat; Acceptance: Stainless steel or brass support bridge is straight and free of bending deformation; valve seating face is uniform with no nicks or uneven gaps.
- Expansion Element & Spring; Acceptance: Return spring is uniformly coiled, concentric, and free of distortion; copper wax pellet capsule is completely sealed with zero wax leakage or cracking.
- Bleed Valve / Jiggle Pin Freedom; Acceptance: Bypass air bleed hole is open and clean; jiggle pin or check ball is loose and moves freely within its slot without binding.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Flange Outer Diameter (OD); Location: Across the outermost edge of the main mounting seating flange (2 axes at 90°).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Overall Assembly Height (Closed); Location: From the apex of the frame bridge to the base of the closed bypass sealing disk.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Valve Opening Stroke (Functional Check); Location: Submerged hot water bath testing; measuring total valve lift distance at the fully open rated temperature spec.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-023 — Thrust Washer
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Running Face & Oil Grooves; Acceptance: The anti-friction thrust face overlay is entirely uniform; oil distribution grooves are clean, full-depth, and entirely free of machining burrs, scoring, or flaking.
- Steel Backing Flatness; Acceptance: The raw steel backing face is smooth, clean, flat, and completely free of localized high spots, transport nicks, or oxidation.
- Locating Tabs / Tabs Profile; Acceptance: Anti-rotation locking tabs or outer ear locations are clean-cut, unbent, and square.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Washer Total Thickness; Location: With a micrometer at 4 equidistant points (90° intervals) around the center circle of the washer body.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Outer Diameter (OD) and Inner Diameter (ID); Location: Across 2 perpendicular axes using a digital caliper.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Flatness Deviation; Location: On a certified precision surface plate with a feeler gauge to ensure zero warping.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-024 — Water Pump
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Casting & Housing Integrity; Acceptance: Pump body volute and mounting flanges are entirely free of casting voids, hairline cracks, or sand inclusions.
- Impeller Seating & Vanes; Acceptance: Impeller blades are complete and undamaged; zero cavitation pitting, casting slag, or distortion; securely pressed onto the pump shaft.
- Rotational Freedom & Bearing Feel; Acceptance: Shaft rotates smoothly by hand through a full 360° loop; zero evidence of internal roughness, tight spots, clicking, or excessive dry friction feel.
- Weep Hole Openness; Acceptance: The internal cartridge seal weep hole is open and completely free of excess sealant, metal chips, or signs of transit oil leaks.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Mounting Flange Flatness; Location: Straight-edge and feeler gauge check across the block-mating flange face surface.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Drive Pulley / Hub Protrusion Height; Location: From the flat block-mounting flange plane to the outer face of the drive pulley/gear hub.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Impeller Back-Clearance; Location: Distance between the rear edge of the impeller vanes and the inner volute casting wall.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-025 — Flywheel
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Clutch Friction Surface Finish; Acceptance: Ground clutch interface area is flat and mirror-smooth; zero evidence of heat checking, grinding scoring, radial scratches, or deep handling dents.
- Starter Ring Gear Teeth; Acceptance: All ring gear teeth are complete and fully formed; zero chipped, broken, or cracked teeth; leading engagement chamfers are clean and uniform.
- Crank Snout Centering Pilot & Thread Holes; Acceptance: Center locating pilot bore and crankshaft mounting bolt paths are free of rust, burrs, cross-drilling edge steps, or metal chips.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Friction Face Flatness (Total Sweep); Location: Via a dial indicator sweep across the outer radial friction surface while anchored on a true rotation fixture.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Pilot Bearing Pocket Inner Diameter (ID); Location: Inside diameter of the center pilot bearing bore (measured across 2 perpendicular axes).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Starter Ring Gear Outer Diameter (OD); Location: At 3 points (120° intervals) across the top tips of the ring gear teeth.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-026 — Stud Kit
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Rolled Thread Profiles; Acceptance: Threads on both ends (block engagement and nut engagement) are fully formed and crisp; zero flat crests, cross-thread nicks, or razor burrs.
- Unthreaded Center Shank; Acceptance: The solid intermediate shank body is straight and uniform; zero machining tool gouges, linear stretch marks, or hydrogen embrittlement micro-cracks.
- Hex Nut Internal Threading; Acceptance: Kit fasteners/nuts are fully tapped; threads are clean and free of plating build-up or loose internal metal flakes.
- Hardened Washer Face Uniformity; Acceptance: Parallel surfaces of parallel washers are smooth and clean; zero stamping burrs, edge splitting, or uneven dish warping.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Total Stud Length; Location: End-to-end parallel to the central stud axis.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Block-End & Nut-End Thread Lengths; Location: Axial length check of the short and long thread segments using a digital caliper depth rod.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Nut Hex Parallel Width; Location: Micrometer measurement across the flat driving faces of a sample nut from the kit.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-027 — Main Bearing (Shell Half)
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Antifriction Lining Overlay; Acceptance: Interior bearing lining surface is 100% uniform; zero scratches, scuffs, layer blistering, exposed mid-layers, or embedded foreign matter.
- Steel Backing Condition; Acceptance: Rear steel shell face is smooth, clean, and uniform; zero rust stains, pitting, fretting shadows, or deep stamping indentations.
- Locating Tangs & Parting Lines; Acceptance: Anti-rotation locating tangs are sharp, crisp, and completely unbent; parting line mating faces are flat and free of upset metal or handling burrs.
- Oil Grooves & Holes; Acceptance: Oil supply channels and cross-holes are cleanly punched/machined with smoothly chamfered edges; no loose backing burrs.
- Thrust Flanges (for combination main/thrust bearings only); Acceptance: Flange lateral faces are smooth and free of machining tears, edge scoring, or handling nicks.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Bearing Shell Wall Thickness; Location: Measured at the exact center apex of the bearing half using a specialized ball-anvil micrometer.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Overall Shell Width; Location: Measured parallel to the bearing centerline across the parting line edges.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Bearing Free Spread; Location: Measured distance across the extreme outer tips of the bearing shell parting lines in its relaxed state.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Flange Thickness / Total Width (for combination main/thrust bearings only); Location: Measured from thrust face to thrust face parallel to the crankshaft axis.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-028 — Cam Bearing (Bushing / Sleeve)
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Inside Diameter (ID) Lining Finish; Acceptance: Babbitt or overlay lining material is continuous and smoothly machined; zero scoring, pitting, handling marks, or peeling from the backing material.
- Outside Diameter (OD) Surface Quality; Acceptance: Outer steel or bronze backing surface is uniform and smooth to facilitate proper press-fit; free of heavy insertion scratches, burrs, or corrosion.
- Chamfers & Lead-in Edges; Acceptance: OD edge chamfers are cleanly formed and deburred to prevent scoring the engine block cam tunnel during installation.
- Oil Supply Holes; Acceptance: Lubrication holes are completely open, round, and free of punching flash or hanging metal slivers.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Bearing Wall Thickness; Location: Measured using a ball-anvil micrometer at 3 points around the circumference.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Bearing Outer Diameter (OD); Location: Measured across 2 axes at 90° to verify press-fit sizing before installation.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Total Bushing Width; Location: Measured parallel to the center axis of the sleeve.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-029 — Connecting Rod
**Availability:** Active/selectable.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
- Outer Carton Condition; Acceptance: Carton undamaged — no crushing, tears, moisture staining, or exposed contents
- Box / Package Label; Acceptance: Label present; part number, description, and quantity match purchase order exactly
- Part Marking; Acceptance: PDI logo and part number permanently marked on part; matches purchase order
- Quantity Verification; Acceptance: Physical count matches packing slip and purchase order line item; no shorts or mixed counts
- Corrosion / Contamination Protection; Acceptance: Parts wrapped in VCI film or oil-coated; no visible rust, oxidation, or contamination on arrival
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
- Rod Beam & Cap Surface; Acceptance: Forged or machined surfaces are completely free of deep nicks, transport gouges, heat discoloration, or stamping cracks; no sharp structural stress-risers.
- Big-End Mating Serrations / Fractured Face; Acceptance: Cap-to-rod mating interfaces (whether machined serrations or fractured split surfaces) are 100% clean, unbruised, and free of foreign particles or damaged teeth.
- Small-End Bushing Seating; Acceptance: Pin bore bushing is securely pressed into place, aligned with the oil pathway, and free of internal scoring, flaking, or edge burrs.
- Bolt Seat Counterbores; Acceptance: Machined seating areas for the rod bolts are flat, clean, and free of tool chatter marks or debris.
- Weight Class / Matching Marks; Acceptance: Rod and cap matching serialization or weight class indicators are clearly legible, matched, and permanently marked.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
- Big-End Bore Diameter; Location: Measured with rod cap installed and torqued to specification (0° and 90° axes with respect to the beam axis).; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Small-End Pin Bushing Inner Diameter (ID); Location: Measured across 0° and 90° vertical/horizontal planes.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Center-to-Center Distance; Location: Measured distance between the absolute center points of the big-end bore and the small-end bore.; Numerical acceptance limit: Not supplied; resolve to authorized product specification
- Bore Parallelism (Twist and Bend); Location: Alignment checked via precision rod fixture pins to calculate alignment error between the big-end and small-end axes.; Numerical acceptance limit: Not supplied; resolve to authorized product specification

### PDI-IQI-MISC — Miscellaneous
**Availability:** Historical/inactive or hidden reference.
**A. RECEIVING & DOCUMENTATION VERIFICATION** — pfn checklist; once per inspection.
  - Enter pattern-specific results (), with applicability and acceptance rules provided by the controlled inspection plan.
**B. VISUAL INSPECTION** — pass fail checklist; once per item.
  - Enter pattern-specific results (), with applicability and acceptance rules provided by the controlled inspection plan.
**C. DIMENSIONAL INSPECTION** — dimensional; once per item.
  - Enter pattern-specific results (), with applicability and acceptance rules provided by the controlled inspection plan.

## A4. Limits, sampling and review decisions requiring business policy
**Do not fabricate:** any unspecified dimensional limits, tolerances, instrument ranges, sampling plans, AQL criteria, unrecorded supplier identities, historic template release authority, or a blanket authority to use Accepted items. If numerical specifications are unavailable, retain observed values and route to documented evaluation rather than automatically passing. Source-specific critical characteristics may augment but must not silently modify a released standard template. Multi-cavity/multi-cylinder values, image evidence and per-unit identity must remain available in generated reports.
