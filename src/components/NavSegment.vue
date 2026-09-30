<script setup lang="ts">
import {
  PhHouse,
  PhMaskHappy,
  PhFrameCorners,
  PhBooks,
  PhClockCounterClockwise,
  PhGear
} from '@phosphor-icons/vue'
import RubberSegment from './RubberSegment.vue'
import { NAV_ITEMS } from '../lib/nav'

/* 顶部导航(分段控件)。
   六个条目是六个平级页面,不是六个动作:滑块停在哪儿就是当前在看哪一页。
   条目清单在 lib/nav.ts —— 顶部字标也要按页面取名字,那份清单两处共用。

   这里只管渲染与转手状态,当前是哪一页由主界面持有(page / navView)。
   它是最顶层那条横条上的控件,每一页都在,切页时位置不动。

   value 与 App 的 Page 联合类型对得上,但这里不做类型收敛 ——
   它只负责把视图状态转手,不认识具体有哪些页 */

const view = defineModel<string>({ required: true })

defineProps<{
  /* 未配置接口时把设置那枚齿轮标红 */
  warn?: boolean
}>()
</script>

<template>
  <RubberSegment
    v-model="view"
    class="nav-seg"
    :items="NAV_ITEMS"
    :radius="999"
    :height="40"
    :inset="5"
    aria-label="Main navigation"
  >
    <template #home>
      <PhHouse class="seg-ico" aria-hidden="true" />
    </template>
    <template #chars>
      <!-- 人形:角色是"同一个人跨图保持一致"的那件事 -->
      <PhMaskHappy class="seg-ico" aria-hidden="true" />
    </template>
    <template #canvas>
      <!-- 四角取景框:画布是"框住一块地方来加工"的工作台 -->
      <PhFrameCorners class="seg-ico" aria-hidden="true" />
    </template>
    <template #lib>
      <!-- Phosphor 的 Books:表达"收藏成册的提示词库" -->
      <PhBooks class="seg-ico" aria-hidden="true" />
    </template>
    <template #history>
      <PhClockCounterClockwise class="seg-ico" aria-hidden="true" />
    </template>
    <template #settings>
      <PhGear class="seg-ico" :class="{ 'is-warn': warn }" aria-hidden="true" />
    </template>
  </RubberSegment>
</template>

<style scoped>
/* 17px 是照 34px 胶囊定的,导航条加高到 40px 后配套提到 19px,
   与主题按钮的图标同档,两个控件在一行里视觉重量才对得上 */
.nav-seg .seg-ico {
  width: 19px;
  height: 19px;
}
/* 未配置接口时齿轮标红。选中态那层由滑块的反色副本接管,所以排除 .rs-copy */
.nav-seg :deep(.rs-item:not(.rs-copy)[aria-checked='false'] .is-warn) {
  color: var(--danger);
}
</style>
