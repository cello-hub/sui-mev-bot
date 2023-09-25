// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SuiClient } from '@mysten/sui.js/client'
import { BCS, fromB58, fromB64, getSuiMoveConfig } from '@mysten/bcs'
import { TransactionBlock } from '@mysten/sui.js/transactions'
import pLimit from 'p-limit'
const limit = pLimit(5)

const bcs = new BCS(getSuiMoveConfig())
bcs.registerStructType('Order', {
  order_id: 'u64',
  client_order_id: 'u64',
  price: 'u64',
  original_quantity: 'u64',
  quantity: 'u64',
  is_bid: 'bool',
  owner: 'address',
  expire_timestamp: 'u64',
  self_matching_prevention: 'u8'
})

bcs.registerStructType('Table', {
  id: 'address',
  size: 'u64'
})

bcs.registerStructType('Field<K,V>', {
  id: 'address',
  name: 'K',
  value: 'V'
})

bcs.registerStructType('TickLevel', {
  price: 'u64',
  open_orders: 'LinkedTable'
})

bcs.registerStructType('LinkedTable', {
  id: 'address',
  size: 'u64',
  head: 'vector<u64>',
  tail: 'vector<u64>'
})

bcs.registerStructType('Node<V>', {
  prev: 'vector<u64>',
  next: 'vector<u64>',
  value: 'V'
})

bcs.registerStructType('Leaf<V>', {
  key: 'u64',
  value: 'V',
  parent: 'u64'
})

bcs.registerStructType('CritbitTree', {
  root: 'u64',
  internal_nodes: 'Table',
  leaves: 'Table',
  min_leaf: 'u64',
  max_leaf: 'u64',
  next_internal_node_index: 'u64',
  next_leaf_index: 'u64'
})

bcs.registerStructType('Pool', {
  id: 'address',
  bids: 'CritbitTree',
  asks: 'CritbitTree',
  next_bid_order_id: 'u64',
  next_ask_order_id: 'u64',
  usr_open_orders: 'Table',
  taker_fee_rate: 'u64',
  maker_rebate_rate: 'u64',
  tick_size: 'u64',
  lot_size: 'u64'
})

bcs.registerStructType('PoolCreated', {
  pool_id: 'address',
  base_asset: 'string',
  quote_asset: 'string'
  // We don't need other fields for the mev bot
})
const client = new SuiClient({
  url: 'https://sui-mainnet-rpc.nodereal.io'
})

// Implementer Todo : sign and execute the transaction

async function retrieveAllPools() {
  let page = await client.queryEvents({
    query: { MoveEventType: '0xdee9::clob_v2::PoolCreated' }
  })
  const data = page.data
  while (page.hasNextPage) {
    page = await client.queryEvents({
      query: {
        MoveEventType: '0xdee9::clob_v2::PoolCreated'
      },
      cursor: page.nextCursor
    })
    data.push(...page.data)
  }
  return data.map((event) => {
    return bcs.de('PoolCreated', fromB58(event.bcs))
  })
}

async function retrieveExpiredOrders(poolId: string) {
  const pool = await client.getObject({
    id: poolId,
    options: { showBcs: true }
  })
  const poolData = pool.data?.bcs!

  switch (poolData.dataType) {
    // Pool is a move object
    case 'moveObject': {
      const pool = bcs.de('Pool', fromB64(poolData.bcsBytes))
      const asks = await getAllDFPages(pool.asks.leaves.id)
      const bids = await getAllDFPages(pool.bids.leaves.id)

      const ids = [...bids, ...asks].map((bid) => bid.objectId)
      const tickLevels = []

      for (const chunk of chunks(ids, 50)) {
        tickLevels.push(
          ...(await client
            .multiGetObjects({ ids: chunk, options: { showBcs: true } })
            .then((responses) => {
              return responses.map((response) => {
                if (!response.error) {
                  const tickLevelBcs = response.data?.bcs!
                  switch (tickLevelBcs.dataType) {
                    case 'moveObject': {
                      return bcs.de(
                        'Field<u64, Leaf<TickLevel>>',
                        fromB64(tickLevelBcs.bcsBytes)
                      ).value.value
                    }
                  }
                } else {
                  // An object could be deleted during query, ignore
                }
              })
            }))
        )
      }

      const orderIdsPromises = []
      for (const tickLevel of tickLevels.filter(
        (tickLevel) => tickLevel !== undefined
      )) {
        // Restrict concurrent requests to avoid a rate limit issue on a public Full node
        orderIdsPromises.push(
          limit(() =>
            getAllDFPages(tickLevel.open_orders.id).then((data) =>
              data.map((node) => node.objectId)
            )
          )
        )
      }
      const orderIds = (await Promise.all(orderIdsPromises)).flat()
      const orders = await getOrders(orderIds)
      const expiredOrders = orders.filter(
        (order) => order.expire_timestamp <= Date.now()
      )
      console.log(
        `Pool ${poolId} has ${expiredOrders?.length} expired orders out of ${orders?.length} orders`
      )
      return expiredOrders
    }
  }
  throw new Error('Invalid pool data type')
}

async function createCleanUpTransaction(
  poolOrders: { pool: any; expiredOrders: any[] }[]
) {
  const tx = new TransactionBlock()

  for (const poolOrder of poolOrders) {
    const orderIds = poolOrder.expiredOrders.map((order) =>
      tx.pure(order.order_id, BCS.U64)
    )
    const orderOwners = poolOrder.expiredOrders.map((order) =>
      tx.pure(order.owner, BCS.ADDRESS)
    )

    const orderIdVec = tx.makeMoveVec({ objects: orderIds, type: 'u64' })
    const orderOwnerVec = tx.makeMoveVec({
      objects: orderOwners,
      type: 'address'
    })

    tx.moveCall({
      target: `0xdee9::clob_v2::clean_up_expired_orders`,
      arguments: [
        tx.object(poolOrder.pool.pool_id),
        tx.object('0x6'),
        orderIdVec,
        orderOwnerVec
      ],
      typeArguments: [poolOrder.pool.base_asset, poolOrder.pool.quote_asset]
    })
  }
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: '0x6c8adbafc9c7082c7b362d262aef7d1dc73589cb6bab27f235468cfa844f097f'
  })

  const costSummary = result.effects.gasUsed
  const rebate =
    parseInt(costSummary.storageRebate) -
    parseInt(costSummary.storageCost) -
    parseInt(costSummary.computationCost)

  return { rebate, tx }
}

// Helper functions to retrieve all pages of dynamic fields
async function getAllDFPages(parentId: string) {
  let page = await client.getDynamicFields({
    parentId: parentId
  })
  const data = page.data
  while (page.hasNextPage) {
    page = await client.getDynamicFields({
      parentId: parentId,
      cursor: page.nextCursor
    })
    data.push(...page.data)
  }
  return data.filter((node) => node.objectId !== undefined)
}

async function getOrders(ids: string[]) {
  const result = []
  for (const chunk of chunks(ids, 50)) {
    result.push(
      ...(await client
        .multiGetObjects({
          ids: chunk,
          options: { showBcs: true }
        })
        .then((responses) => {
          return responses.map((response) => {
            if (!response.error) {
              const objBCS = response.data?.bcs!
              switch (objBCS.dataType) {
                case 'moveObject': {
                  const order = bcs.de(
                    'Field<u64, Node<Order>>',
                    fromB64(objBCS.bcsBytes)
                  )
                  return order.value.value
                }
              }
            } else {
              // An object could be deleted during query, ignore
            }
          })
        }))
    )
  }
  return result.filter((order) => order !== undefined)
}

// Helper function to split an array into chunks
function chunks(data: any[], size: number) {
  return Array.from(new Array(Math.ceil(data.length / size)), (_, i) =>
    data.slice(i * size, i * size + size)
  )
}

const main = async () => {
  // Create a client connected to the Sui network

  // 检索使用PoolCreated事件的所有DeepBook池
  const allPools = await retrieveAllPools()

  // [{
  //   pool_id: 'f0f663cf87f1eb124da2fc9be813e0ce262146f3df60bc2052d738eb41a25899',
  //   base_asset: 'bc3a676894871284b3ccfb2eec66f428612000e2a6e6d23f592ce8833c27c973::coin::COIN',
  //   quote_asset: '5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN'
  // }]

  // 检索每个池中的所有过期订单
  const allExpiredOrdersPromises = []
  for (const pool of allPools) {
    allExpiredOrdersPromises.push(
      retrieveExpiredOrders(pool.pool_id).then((expiredOrders) => {
        return { pool, expiredOrders }
      })
    )
  }
  const allExpiredOrders = (await Promise.all(allExpiredOrdersPromises)).flat()

  // Create a transaction to clean up all expired orders and get the estimated storage fee rebate using devInspectTransactionBlock
  // 如何创建一个交易来清理所有过期订单，然后使用 devInspectTransactionBlock 获取估计的存储费返还：
  const { rebate, tx } = await createCleanUpTransaction(allExpiredOrders)

  console.log(`Total estimated storage fee rebate: ${rebate / 1e9} SUI`)
  console.log(tx)
}

main()
