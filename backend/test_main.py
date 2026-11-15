"""Checks for the backend simulator. Run from the repo root:

    .\\.venv\\Scripts\\python.exe -m unittest backend.test_main -v
"""
import unittest

from fastapi import HTTPException

from .main import SimulationRequest, TOTAL_TRIPS, get_network, simulate


def run(**changes):
    return simulate(SimulationRequest(**changes))


def conserved(column):
    return (column["completedCarTrips"] + column["unservedCarTrips"]
            + column["carTripsShiftedToBus"]) == column["totalCarTrips"]


class NetworkTests(unittest.TestCase):
    def test_roads_join_known_intersections(self):
        network = get_network()
        nodes = {node["id"] for node in network["intersections"]}
        self.assertEqual(len(network["roads"]), 10)
        self.assertEqual(len(nodes), 9)
        for road in network["roads"]:
            self.assertIn(road["from"], nodes)
            self.assertIn(road["to"], nodes)


class SimulationTests(unittest.TestCase):
    def test_no_changes_matches_baseline(self):
        result = run()
        self.assertEqual(result["baseline"], result["scenario"])
        self.assertEqual(result["baseline"]["avgCarTravelMinutes"], 10.41)
        self.assertEqual(result["baseline"]["completedCarTrips"], TOTAL_TRIPS)

    def test_closure_reroutes_and_slows_trips(self):
        result = run(closedRoadIds=["wash_mid"])
        scenario = result["scenario"]
        roads = {road["id"]: road for road in scenario["roads"]}
        self.assertEqual(roads["wash_mid"]["carTrips"], 0)
        self.assertTrue(roads["wash_mid"]["closed"])
        self.assertIsNone(roads["wash_mid"]["travelMinutes"])
        self.assertEqual(roads["nassau_west"]["carTrips"], TOTAL_TRIPS)
        self.assertEqual(scenario["avgCarTravelMinutes"], 20.4)
        self.assertGreater(scenario["avgCarTravelMinutes"], result["baseline"]["avgCarTravelMinutes"])
        self.assertTrue(conserved(scenario))

    def test_extra_lane_relieves_the_detour(self):
        closed = run(closedRoadIds=["wash_mid"])["scenario"]
        widened = run(closedRoadIds=["wash_mid"], extraLanesByRoadId={"alex_north": 1})["scenario"]
        self.assertEqual(widened["avgCarTravelMinutes"], 15.9)
        self.assertLess(widened["avgCarTravelMinutes"], closed["avgCarTravelMinutes"])
        self.assertTrue(conserved(widened))

    def test_both_routes_closed_gives_no_average(self):
        scenario = run(closedRoadIds=["wash_mid", "nassau_west"])["scenario"]
        self.assertEqual(scenario["completedCarTrips"], 0)
        self.assertEqual(scenario["unservedCarTrips"], TOTAL_TRIPS)
        self.assertIsNone(scenario["avgCarTravelMinutes"])
        self.assertTrue(conserved(scenario))

    def test_bad_requests_are_rejected(self):
        for changes in (
            {"closedRoadIds": ["not_a_road"]},
            {"extraLanesByRoadId": {"wash_mid": -1}},
            {"busShiftPercent": 20},
            {"signals": [{"intersectionId": "int_nassau_wash", "mainGreenShare": 0.5}]},
        ):
            with self.subTest(changes=changes), self.assertRaises(HTTPException) as caught:
                run(**changes)
            self.assertEqual(caught.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
