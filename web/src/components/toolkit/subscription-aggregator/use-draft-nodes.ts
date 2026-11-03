import { useEffect, useState } from 'react';
import type { FormInstance } from 'antd';
import { aggregatorErrorText, responseErrorCode } from './aggregator-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorDraftNode, AggregatorProfileInput } from './types';

/**
 * 编辑中（未保存）的配置会选中的节点，给自建组勾选节点与实时匹配用。
 * 订阅源范围、过滤、改名都在别的页签上改，所以只在 active（策略组页打开）时拉取，每次切回来重新拉。
 */
export function useDraftNodes(form: FormInstance<AggregatorProfileInput>, active: boolean) {
  const [nodes, setNodes] = useState<AggregatorDraftNode[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const values = form.getFieldsValue(true) as AggregatorProfileInput;
    subscriptionAggregatorAPI.previewNodes({ sources: values.sources, filter: values.filter, naming: values.naming, dedupe: values.dedupe })
      .then((result) => {
        if (cancelled) return;
        setNodes(result.nodes);
        setError('');
      })
      .catch((loadError) => {
        if (cancelled) return;
        setNodes((current) => current || []);
        setError(aggregatorErrorText(responseErrorCode(loadError), '读取节点列表失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [active, form]);

  return { nodes, error };
}
