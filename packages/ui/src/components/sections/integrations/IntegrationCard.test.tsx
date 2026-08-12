import { describe, expect, test } from 'bun:test';
import React from 'react';

const integrationCards = await import('./Integration' + 'Card').catch(() => ({}));

type IntegrationCardComponent = (props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  header: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) => React.ReactElement;

const IntegrationCard = (
  integrationCards as unknown as {
    IntegrationCard?: IntegrationCardComponent;
  }
).IntegrationCard;

describe('IntegrationCard', () => {
  test('keeps header controls outside the expansion button', () => {
    expect(typeof IntegrationCard).toBe('function');
    if (!IntegrationCard) return;

    const onOpenChange = () => undefined;
    const toggle = <input aria-label="Integration enabled" type="checkbox" />;
    const card = IntegrationCard({
      open: false,
      onOpenChange,
      header: <span>Integration</span>,
      headerAction: toggle,
      children: <div>Details</div>,
    });

    const cardProps = card.props as {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactElement;
    };
    expect(cardProps.open).toBe(false);
    expect(cardProps.onOpenChange).toBe(onOpenChange);

    const surface = cardProps.children as React.ReactElement<{ children: React.ReactNode }>;
    const headerRow = React.Children.toArray(surface.props.children)[0] as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const headerChildren = React.Children.toArray(headerRow.props.children) as React.ReactElement<{
      children?: React.ReactNode;
    }>[];

    expect(headerChildren[0]?.type).toBe('button');
    expect(headerChildren[1]?.props.children).toBe(toggle);
  });
});
