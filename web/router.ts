import { createRouter, createWebHashHistory, type RouterHistory } from 'vue-router';
import { destinations } from './navigation';
import SwitchboardPage from './pages/SwitchboardPage.vue';
import FuturePage from './pages/FuturePage.vue';
import AgentPage from './pages/AgentPage.vue';
import PhonesPage from './pages/PhonesPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import MorePage from './pages/MorePage.vue';
import LivePage from './pages/LivePage.vue';
import PeoplePage from './pages/PeoplePage.vue';
import LogPage from './pages/LogPage.vue';

const views = { Switchboard: SwitchboardPage, Log: LogPage, People: PeoplePage, Insights: FuturePage, Agent: AgentPage, Phones: PhonesPage, Settings: SettingsPage };
export function createAppRouter(history: RouterHistory = createWebHashHistory()) {
  return createRouter({
    history,
    routes: [
      ...destinations.map((item) => ({ path: item.path, component: views[item.title], meta: { title: item.title } })),
      { path: '/live', component: LivePage, meta: { title: 'Live' } },
      { path: '/more', component: MorePage, meta: { title: 'More' } },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
    scrollBehavior: () => ({ top: 0 }),
  });
}
