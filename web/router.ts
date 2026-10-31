import { createRouter, createWebHashHistory, type RouterHistory } from 'vue-router';
import { destinations } from './navigation';
import SwitchboardPage from './pages/SwitchboardPage.vue';
import InsightsPage from './pages/InsightsPage.vue';
import AgentPage from './pages/AgentPage.vue';
import PhonesPage from './pages/PhonesPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import MorePage from './pages/MorePage.vue';
import LivePage from './pages/LivePage.vue';
import PeoplePage from './pages/PeoplePage.vue';
import AccessPage from './pages/AccessPage.vue';
import GuidePage from './pages/GuidePage.vue';

const views = { Switchboard: SwitchboardPage, People: PeoplePage, Access: AccessPage, Insights: InsightsPage, Agent: AgentPage, Phones: PhonesPage, Settings: SettingsPage, Guide: GuidePage };
export function createAppRouter(history: RouterHistory = createWebHashHistory()) {
  return createRouter({
    history,
    routes: [
      ...destinations.map((item) => ({ path: item.path, component: views[item.title], meta: { title: item.title } })),
      { path: '/log', redirect: '/' },
      { path: '/live', component: LivePage, meta: { title: 'Live' } },
      { path: '/more', component: MorePage, meta: { title: 'More' } },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
    scrollBehavior: () => ({ top: 0 }),
  });
}
