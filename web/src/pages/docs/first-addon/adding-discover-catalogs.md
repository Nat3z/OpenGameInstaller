---
layout: ../../../layouts/BlogLayout.astro
title: Adding Discover Catalogs & Carousel
description: Add catalog sections and carousel content for the Discover view.
part: 7
section: Your First Addon
---

The Discover view is powered by the `catalog` event. This lets your addon provide structured game collections and featured carousel items.

## Basic `catalog` event

At minimum, return section data:

```typescript
addon.on('catalog', (event) => {
  event.resolve({
    featured: {
      name: 'Featured',
      description: 'Top picks from this addon',
      listings: [
        {
          appID: 1,
          name: 'Example Game',
          storefront: 'my-store',
          capsuleImage: 'https://example.com/capsule.jpg',
        },
      ],
    },
  });
});
```

## Adding a carousel

To power the top Discover hero carousel, return an object with both `sections` and `carousel`:

```typescript
addon.on('catalog', (event) => {
  event.resolve({
    sections: {
      featured: {
        name: 'Featured',
        description: 'Top picks from this addon',
        listings: [
          {
            appID: 1,
            name: 'Example Game',
            storefront: 'my-store',
            capsuleImage: 'https://example.com/capsule.jpg',
          },
        ],
      },
    },
    carousel: {
      hero1: {
        name: 'Example Game',
        description: 'Our featured recommendation',
        carouselImage: 'https://example.com/carousel.jpg',
        fullBannerImage: 'https://example.com/banner.jpg',
        appID: 1,
        storefront: 'my-store',
        capsuleImage: 'https://example.com/capsule.jpg',
      },
    },
  });
});
```

## Carousel item requirements

- Required fields:
  - `name`
  - `description`
  - `carouselImage`
- Optional but recommended:
  - `appID`
  - `storefront`
  - `fullBannerImage`
  - `capsuleImage`

If `appID` and `storefront` are set, the carousel item can open the game store page directly.

## Alternate carousel format

`carousel` can also be an array:

```typescript
carousel: [
  {
    name: 'Example Game',
    description: 'Our featured recommendation',
    carouselImage: 'https://example.com/carousel.jpg',
    appID: 1,
    storefront: 'my-store',
  },
];
```

## Tips

- Keep listing data lightweight and fast to compute.
- Use stable image URLs to avoid flickering or broken cards.
- Ensure `storefront` values match the storefronts in your addon config.
