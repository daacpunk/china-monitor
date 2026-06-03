import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
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
import Trends from "@/pages/Trends";
import Attribution from "@/pages/Attribution";
import Settings from "@/pages/Settings";
import Audit from "@/pages/Audit";
import Imports from "@/pages/Imports";

function AppRouter() {
  return (
    <Layout>
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
        <Route path="/trends" component={Trends} />
        <Route path="/attribution" component={Attribution} />
        <Route path="/settings" component={Settings} />
        <Route path="/audit" component={Audit} />
        <Route path="/imports" component={Imports} />
        <Route component={NotFound} />
      </Switch>
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
