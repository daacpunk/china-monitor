import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { Layout } from "@/components/Layout";
import NotFound from "@/pages/not-found";
import Overview from "@/pages/Overview";
import Investment from "@/pages/Investment";
import Gdp from "@/pages/Gdp";
import Fiscal from "@/pages/Fiscal";
import Equity from "@/pages/Equity";
import EquityDeepDive from "@/pages/EquityDeepDive";
import KShape from "@/pages/KShape";
import Margins from "@/pages/Margins";
import Property from "@/pages/Property";
import Outlook from "@/pages/Outlook";
import Policy from "@/pages/Policy";
import Sectors from "@/pages/Sectors";
import Report from "@/pages/Report";
import Automation from "@/pages/Automation";
import Trends from "@/pages/Trends";
import Attribution from "@/pages/Attribution";
import Scenarios from "@/pages/Scenarios";
import Brief from "@/pages/Brief";
import Settings from "@/pages/Settings";
import Audit from "@/pages/Audit";
import Imports from "@/pages/Imports";
import Costs from "@/pages/Costs";
import Diagnostics from "@/pages/Diagnostics";

function AppRouter() {
  const [location] = useLocation();
  return (
    <Layout>
      {/* Keyed by location so a crash on one page is cleared when navigating away. */}
      <ErrorBoundary key={location} label={location}>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/investment" component={Investment} />
        <Route path="/gdp" component={Gdp} />
        <Route path="/fiscal" component={Fiscal} />
        <Route path="/equity" component={Equity} />
        <Route path="/equity-deepdive" component={EquityDeepDive} />
        <Route path="/kshape" component={KShape} />
        <Route path="/margins" component={Margins} />
        <Route path="/property" component={Property} />
        <Route path="/outlook" component={Outlook} />
        <Route path="/policy" component={Policy} />
        <Route path="/sectors" component={Sectors} />
        <Route path="/report" component={Report} />
        <Route path="/automation" component={Automation} />
        <Route path="/trends" component={Trends} />
        <Route path="/attribution" component={Attribution} />
        <Route path="/scenarios" component={Scenarios} />
        <Route path="/brief" component={Brief} />
        <Route path="/settings" component={Settings} />
        <Route path="/audit" component={Audit} />
        <Route path="/imports" component={Imports} />
        <Route path="/costs" component={Costs} />
        <Route path="/diagnostics" component={Diagnostics} />
        <Route component={NotFound} />
      </Switch>
      </ErrorBoundary>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
