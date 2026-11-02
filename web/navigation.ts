export const destinations = [
  { path: '/', title: 'Switchboard', icon: 'home' },
  { path: '/people', title: 'People', icon: 'people' },
  { path: '/access', title: 'Access', icon: 'access' },
  { path: '/insights', title: 'Insights', icon: 'insights' },
  { path: '/agent', title: 'Agent', icon: 'agent' },
  { path: '/phones', title: 'Phones', icon: 'phone' },
  { path: '/settings', title: 'Settings', icon: 'settings' },
  { path: '/call-skills', title: 'Call skills', icon: 'skills' },
  { path: '/guide', title: 'Guide', icon: 'guide' },
] as const;
export const moreDestinations = destinations.slice(3);
export const mobileDestinations = [destinations[0], { path: '/live', title: 'Live', icon: 'live' }, destinations[1], destinations[2], { path: '/more', title: 'More', icon: 'more' }];
