// MOCK of GET /api/network. Used until the backend is ready (see CONFIG in api.js).
// Key names confirmed with Sizar: intersections, roads, signalIntersections, busRoute (may be null).
// Road and intersection IDs and names come from testing/road-network.md (Draft v2,
// sources: map.princeton.edu and facilities.princeton.edu/maps).
// Signal intersections and the bus route follow testing/test-plan.md (TC-05, TC-06, TC-07).
// x/y are a PLACEHOLDER schematic layout (north is up), NOT real coordinates.
const MOCK_NETWORK = {
  intersections: [
    { id: "int_nassau_univ",    name: "Nassau St & University Pl",    x: 260, y: 80 },
    { id: "int_nassau_wash",    name: "Nassau St & Washington Rd",    x: 540, y: 80 },
    { id: "int_mercer_alex",    name: "Mercer St & Alexander St",     x: 110, y: 230 },
    { id: "int_wash_prospect",  name: "Washington Rd & Prospect Ave", x: 540, y: 210 },
    { id: "int_prospect_olden", name: "Prospect Ave & Olden St",      x: 740, y: 210 },
    { id: "int_wash_goheen",    name: "Washington Rd & Goheen Walk",  x: 540, y: 350 },
    { id: "int_alex_univ",      name: "Alexander St & University Pl", x: 230, y: 420 },
    { id: "int_wash_faculty",   name: "Washington Rd & Faculty Rd",   x: 540, y: 530 },
    { id: "int_alex_faculty",   name: "Alexander St & Faculty Rd",    x: 320, y: 550 }
  ],
  roads: [
    { id: "nassau_west",   name: "Nassau Street (West)",                    from: "int_nassau_wash",   to: "int_nassau_univ" },
    { id: "nassau_mercer", name: "Nassau Street / Mercer Street Connector", from: "int_nassau_univ",   to: "int_mercer_alex" },
    { id: "alex_north",    name: "Alexander Street (North)",                from: "int_mercer_alex",   to: "int_alex_univ" },
    { id: "alex_station",  name: "Alexander Street (Station Front)",        from: "int_alex_univ",     to: "int_alex_faculty" },
    { id: "univ_place",    name: "University Place",                        from: "int_nassau_univ",   to: "int_alex_univ" },
    { id: "wash_north",    name: "Washington Road (North)",                 from: "int_nassau_wash",   to: "int_wash_prospect" },
    { id: "wash_mid",      name: "Washington Road (Mid / JRR)",             from: "int_wash_prospect", to: "int_wash_goheen" },
    { id: "wash_south",    name: "Washington Road (South)",                 from: "int_wash_goheen",   to: "int_wash_faculty" },
    { id: "faculty_rd",    name: "Faculty Road",                            from: "int_wash_faculty",  to: "int_alex_faculty" },
    { id: "prospect_ave",  name: "Prospect Avenue",                         from: "int_wash_prospect", to: "int_prospect_olden" }
  ],
  signalIntersections: ["int_wash_prospect", "int_nassau_univ"],
  busRoute: {
    name: "TigerTransit Station Connector",
    roadIds: ["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"]
  }
};
