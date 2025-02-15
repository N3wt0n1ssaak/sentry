import type {Dispatch, SetStateAction} from 'react';
import {Fragment, useCallback, useEffect, useMemo} from 'react';
import styled from '@emotion/styled';
import isEqual from 'lodash/isEqual';

import {CompactSelect} from 'sentry/components/compactSelect';
import {Tooltip} from 'sentry/components/tooltip';
import {CHART_PALETTE} from 'sentry/constants/chartPalette';
import {IconClock, IconGraph} from 'sentry/icons';
import {t} from 'sentry/locale';
import {space} from 'sentry/styles/space';
import {dedupeArray} from 'sentry/utils/dedupeArray';
import {
  aggregateOutputType,
  parseFunction,
  prettifyParsedFunction,
} from 'sentry/utils/discover/fields';
import {MutableSearch} from 'sentry/utils/tokenizeSearch';
import usePrevious from 'sentry/utils/usePrevious';
import {formatVersion} from 'sentry/utils/versions/formatVersion';
import ChartContextMenu from 'sentry/views/explore/components/chartContextMenu';
import {useChartInterval} from 'sentry/views/explore/hooks/useChartInterval';
import {useDataset} from 'sentry/views/explore/hooks/useDataset';
import {useVisualizes} from 'sentry/views/explore/hooks/useVisualizes';
import Chart, {
  ChartType,
  useSynchronizeCharts,
} from 'sentry/views/insights/common/components/chart';
import ChartPanel from 'sentry/views/insights/common/components/chartPanel';
import {useSortedTimeSeries} from 'sentry/views/insights/common/queries/useSortedTimeSeries';
import {CHART_HEIGHT} from 'sentry/views/insights/database/settings';

import {useGroupBys} from '../hooks/useGroupBys';
import {useResultMode} from '../hooks/useResultsMode';
import {useSorts} from '../hooks/useSorts';
import {TOP_EVENTS_LIMIT, useTopEvents} from '../hooks/useTopEvents';
import {formatSort} from '../tables/aggregatesTable';

interface ExploreChartsProps {
  query: string;
  setError: Dispatch<SetStateAction<string>>;
}

const exploreChartTypeOptions = [
  {
    value: ChartType.LINE,
    label: t('Line'),
  },
  {
    value: ChartType.AREA,
    label: t('Area'),
  },
  {
    value: ChartType.BAR,
    label: t('Bar'),
  },
];

export const EXPLORE_CHART_GROUP = 'explore-charts_group';

// TODO: Update to support aggregate mode and multiple queries / visualizations
export function ExploreCharts({query, setError}: ExploreChartsProps) {
  const [dataset] = useDataset({allowRPC: true});
  const [visualizes, setVisualizes] = useVisualizes();
  const [interval, setInterval, intervalOptions] = useChartInterval();
  const {groupBys} = useGroupBys();
  const [resultMode] = useResultMode();
  const topEvents = useTopEvents();

  const fields: string[] = useMemo(() => {
    if (resultMode === 'samples') {
      return [];
    }

    return [...groupBys, ...visualizes.flatMap(visualize => visualize.yAxes)].filter(
      Boolean
    );
  }, [resultMode, groupBys, visualizes]);
  const [sorts] = useSorts({fields});

  const orderby: string | string[] | undefined = useMemo(() => {
    if (!sorts.length) {
      return undefined;
    }

    return sorts.map(formatSort);
  }, [sorts]);

  const yAxes = useMemo(() => {
    const deduped = dedupeArray(visualizes.flatMap(visualize => visualize.yAxes));
    deduped.sort();
    return deduped;
  }, [visualizes]);

  const options = useMemo(() => {
    const search = new MutableSearch(query);

    // Filtering out all spans with op like 'ui.interaction*' which aren't
    // embedded under transactions. The trace view does not support rendering
    // such spans yet.
    search.addFilterValues('!transaction.span_id', ['00']);

    return {
      search,
      yAxis: yAxes,
      interval,
      fields,
      orderby,
      topEvents,
    };
  }, [query, yAxes, interval, fields, orderby, topEvents]);

  const previousQuery = usePrevious(query);
  const previousOptions = usePrevious(options);
  const canUsePreviousResults = useMemo(() => {
    if (!isEqual(query, previousQuery)) {
      return false;
    }

    if (!isEqual(options.interval, previousOptions.interval)) {
      return false;
    }

    if (!isEqual(options.fields, previousOptions.fields)) {
      return false;
    }

    if (!isEqual(options.orderby, previousOptions.orderby)) {
      return false;
    }

    if (!isEqual(options.topEvents, previousOptions.topEvents)) {
      return false;
    }

    return true;
  }, [query, previousQuery, options, previousOptions]);

  const timeSeriesResult = useSortedTimeSeries(options, 'api.explorer.stats', dataset);

  const previousTimeSeriesResult = usePrevious(timeSeriesResult);

  useEffect(() => {
    setError(timeSeriesResult.error?.message ?? '');
  }, [setError, timeSeriesResult.error?.message]);

  const getSeries = useCallback(
    (dedupedYAxes: string[], formattedYAxes: (string | undefined)[]) => {
      const shouldUsePreviousResults =
        timeSeriesResult.isPending &&
        canUsePreviousResults &&
        dedupedYAxes.every(yAxis => previousTimeSeriesResult.data.hasOwnProperty(yAxis));

      const data = dedupedYAxes.flatMap((yAxis, i) => {
        const series = shouldUsePreviousResults
          ? previousTimeSeriesResult.data[yAxis]
          : timeSeriesResult.data[yAxis];

        return (series ?? []).map(s => {
          // We replace the series name with the formatted series name here
          // when possible as it's cleaner to read.
          //
          // We can't do this in top N mode as the series name uses the row
          // values instead of the aggregate function.
          if (s.seriesName === yAxis) {
            return {
              ...s,
              seriesName: formattedYAxes[i] ?? yAxis,
            };
          }
          return s;
        });
      });

      return {
        data,
        error: shouldUsePreviousResults
          ? previousTimeSeriesResult.error
          : timeSeriesResult.error,
        loading: shouldUsePreviousResults
          ? previousTimeSeriesResult.isPending
          : timeSeriesResult.isPending,
      };
    },
    [canUsePreviousResults, timeSeriesResult, previousTimeSeriesResult]
  );

  const handleChartTypeChange = useCallback(
    (chartType: ChartType, index: number) => {
      const newVisualizes = visualizes.slice();
      newVisualizes[index] = {...newVisualizes[index], chartType};
      setVisualizes(newVisualizes);
    },
    [visualizes, setVisualizes]
  );

  useSynchronizeCharts(
    visualizes.length,
    !timeSeriesResult.isPending,
    EXPLORE_CHART_GROUP
  );

  const shouldRenderLabel = visualizes.length > 1;

  return (
    <Fragment>
      {visualizes.map((visualize, index) => {
        const dedupedYAxes = dedupeArray(visualize.yAxes);

        const formattedYAxes = dedupedYAxes.map(yaxis => {
          const func = parseFunction(yaxis);
          return func ? prettifyParsedFunction(func) : undefined;
        });

        const {chartType, label, yAxes: visualizeYAxes} = visualize;
        const chartIcon =
          chartType === ChartType.LINE
            ? 'line'
            : chartType === ChartType.AREA
              ? 'area'
              : 'bar';

        const {data, error, loading} = getSeries(dedupedYAxes, formattedYAxes);

        const outputTypes = new Set(
          formattedYAxes.filter(Boolean).map(aggregateOutputType)
        );

        return (
          <ChartContainer key={index}>
            <ChartPanel>
              <ChartHeader>
                {shouldRenderLabel && <ChartLabel>{label}</ChartLabel>}
                <ChartTitle>{formattedYAxes.filter(Boolean).join(', ')}</ChartTitle>
                <Tooltip
                  title={t('Type of chart displayed in this visualization (ex. line)')}
                >
                  <CompactSelect
                    triggerProps={{
                      icon: <IconGraph type={chartIcon} />,
                      borderless: true,
                      showChevron: false,
                      size: 'sm',
                    }}
                    value={chartType}
                    menuTitle="Type"
                    options={exploreChartTypeOptions}
                    onChange={option => handleChartTypeChange(option.value, index)}
                  />
                </Tooltip>
                <Tooltip
                  title={t('Time interval displayed in this visualization (ex. 5m)')}
                >
                  <CompactSelect
                    value={interval}
                    onChange={({value}) => setInterval(value)}
                    triggerProps={{
                      icon: <IconClock />,
                      borderless: true,
                      showChevron: false,
                      size: 'sm',
                    }}
                    menuTitle="Interval"
                    options={intervalOptions}
                  />
                </Tooltip>
                <ChartContextMenu
                  visualizeYAxes={visualizeYAxes}
                  query={query}
                  interval={interval}
                  visualizeIndex={index}
                />
              </ChartHeader>
              <Chart
                height={CHART_HEIGHT}
                grid={{
                  left: '0',
                  right: '0',
                  top: '8px',
                  bottom: '0',
                }}
                legendFormatter={value => formatVersion(value)}
                data={data}
                error={error}
                loading={loading}
                chartGroup={EXPLORE_CHART_GROUP}
                // TODO Abdullah: Make chart colors dynamic, with changing topN events count and overlay count.
                chartColors={CHART_PALETTE[TOP_EVENTS_LIMIT - 1]}
                type={chartType}
                aggregateOutputFormat={
                  outputTypes.size === 1 ? outputTypes.keys().next().value : undefined
                }
                showLegend
              />
            </ChartPanel>
          </ChartContainer>
        );
      })}
    </Fragment>
  );
}

const ChartContainer = styled('div')`
  display: grid;
  gap: 0;
  grid-template-columns: 1fr;
  margin-bottom: ${space(2)};
`;

const ChartHeader = styled('div')`
  display: flex;
  justify-content: space-between;
`;

const ChartTitle = styled('div')`
  ${p => p.theme.text.cardTitle}
  line-height: 32px;
  flex: 1;
`;

const ChartLabel = styled('div')`
  background-color: ${p => p.theme.purple100};
  border-radius: ${p => p.theme.borderRadius};
  text-align: center;
  min-width: 32px;
  color: ${p => p.theme.purple400};
  white-space: nowrap;
  font-weight: ${p => p.theme.fontWeightBold};
  align-content: center;
  margin-right: ${space(1)};
`;
