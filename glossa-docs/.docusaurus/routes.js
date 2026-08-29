import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/glossa/blog',
    component: ComponentCreator('/glossa/blog', 'd6b'),
    exact: true
  },
  {
    path: '/glossa/blog/archive',
    component: ComponentCreator('/glossa/blog/archive', '14f'),
    exact: true
  },
  {
    path: '/glossa/blog/tags',
    component: ComponentCreator('/glossa/blog/tags', 'ead'),
    exact: true
  },
  {
    path: '/glossa/blog/tags/welcome',
    component: ComponentCreator('/glossa/blog/tags/welcome', 'ccc'),
    exact: true
  },
  {
    path: '/glossa/blog/welcome',
    component: ComponentCreator('/glossa/blog/welcome', '70b'),
    exact: true
  },
  {
    path: '/glossa/roadmap',
    component: ComponentCreator('/glossa/roadmap', '048'),
    exact: true
  },
  {
    path: '/glossa/docs',
    component: ComponentCreator('/glossa/docs', '10c'),
    routes: [
      {
        path: '/glossa/docs',
        component: ComponentCreator('/glossa/docs', '1a1'),
        routes: [
          {
            path: '/glossa/docs',
            component: ComponentCreator('/glossa/docs', '92c'),
            routes: [
              {
                path: '/glossa/docs/ai-generated-banner',
                component: ComponentCreator('/glossa/docs/ai-generated-banner', '986'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/glossa/docs/architecture',
                component: ComponentCreator('/glossa/docs/architecture', 'fe1'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/glossa/docs/intro',
                component: ComponentCreator('/glossa/docs/intro', 'b3c'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/glossa/docs/ontology',
                component: ComponentCreator('/glossa/docs/ontology', 'cbb'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/glossa/docs/overview',
                component: ComponentCreator('/glossa/docs/overview', '9fd'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/glossa/docs/platforms',
                component: ComponentCreator('/glossa/docs/platforms', '165'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/glossa/docs/status',
                component: ComponentCreator('/glossa/docs/status', 'dd1'),
                exact: true,
                sidebar: "docsSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '/glossa/',
    component: ComponentCreator('/glossa/', '8a8'),
    exact: true
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
