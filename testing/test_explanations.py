import unittest
from fastapi import HTTPException
from backend.main import ExplanationRequest, explain_change
from backend.simulator import SimulationRequest, run_simulation, ROADS

class ExplanationTests(unittest.TestCase):
    def setUp(self):
        self.base=SimulationRequest(tripDemand=300)
        self.road='alex_station'
    def explain(self, after, before=None, road=None):
        return explain_change(ExplanationRequest(scenario=after,before=before or self.base,roadId=road or self.road))['text']
    def test_lane_numbers(self):
        after=self.base.model_copy(update={'extraLanesByRoadId':{self.road:1}})
        text=self.explain(after)
        self.assertIn('100 to 200',text)
        self.assertIn('6.02 to 5.14',text)
    def test_lane_retains_speed_edit(self):
        road=ROADS[self.road]
        data=self.base.model_dump() | {'speedStretches':[dict(startId=road['from'],endId=road['to'],roadIds=[self.road],speedLimitMph=35)]}
        before=SimulationRequest(**data)
        after=before.model_copy(update={'extraLanesByRoadId':{self.road:1}})
        text=self.explain(after,before)
        expected=run_simulation(before)['avgCarTravelMinutes']
        self.assertIn(f'{expected:.2f} to',text)
        self.assertNotIn('speed limit changed',text)
        self.assertIn('speed limit changed',self.explain(before))
    def test_closure_and_signal(self):
        self.assertIn('now closed',self.explain(self.base.model_copy(update={'closedRoadIds':[self.road]})))
        after=SimulationRequest(**(self.base.model_dump() | {'signals':[{'intersectionId':'int_nassau_wash','mainGreenShare':.5}]}))
        self.assertIn('Average signal wait',self.explain(after))
    def test_bus(self):
        data=self.base.model_dump() | {'customBusRoutes':[{'id':'custom_test','name':'Test','points':[{'endpointId':self.base.originId},{'endpointId':self.base.destinationId}]}], 'enabledBusRouteIds':['custom_test'],'busShiftPercent':35}
        text=self.explain(SimulationRequest(**data))
        self.assertIn('Whole trips replaced by bus changed from 0 to 105',text)
    def test_unused_road(self):
        used={r['id'] for r in run_simulation(self.base)['roads']}
        road=next(id for id,r in ROADS.items() if id not in used and r.get('carAccess',True) and not r.get('parentId'))
        after=self.base.model_copy(update={'extraLanesByRoadId':{road:1}})
        text=self.explain(after,road=road)
        self.assertIn('100 to 200',text)
        self.assertIn('carries no cars',text)
    def test_partial_bus_and_unreachable(self):
        from backend.princeton_network import follow_route, endpoint_node
        result=run_simulation(self.base)
        path=max(result['carRoutes'],key=lambda r:len(r['roadIds']))['roadIds']
        nodes=follow_route(ROADS,path,endpoint_node(self.base.originId))
        scenario=SimulationRequest(**(self.base.model_dump() | {
            'customBusRoutes':[{'id':'custom_partial','name':'Partial','points':[
                {'endpointId':nodes[1]},{'endpointId':nodes[-2]}]}],
            'enabledBusRouteIds':['custom_partial'],'busShiftPercent':35}))
        actual=run_simulation(scenario)
        self.assertGreater(actual['partialBusTrips'],0)
        text=self.explain(scenario)
        self.assertIn(f"part of the route changed from 0 to {actual['partialBusTrips']}",text)
        closed=list({r for route in result['carRoutes'] for r in route['roadIds']})
        text=self.explain(self.base.model_copy(update={'closedRoadIds':closed}))
        self.assertIn('No car trips completed',text)
    def test_invalid_comparison(self):
        with self.assertRaises(HTTPException):
            self.explain(SimulationRequest(tripDemand=100))

if __name__=='__main__': unittest.main()
