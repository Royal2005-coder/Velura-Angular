import { HttpError, sendJson } from "../http.js";
import { selectOne, selectRows } from "../supabase.js";

export async function handleProductsRoute(req, res, subRoute, action, corsHeaders) {
  if (subRoute === "products") {
    if (req.method === "GET") {
      if (action) {
        const product = await selectOne("product", { product_id: `eq.${action}` }, { useAnonKey: true });
        if (!product) {
          throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm");
        }
        let variants = [];
        if (product.is_combo) {
          const { rows: comboItems } = await selectRows("combo_item", { combo_product_id: `eq.${product.product_id}` }, { useAnonKey: true });
          const variantIds = comboItems.map(ci => ci.component_variant_id).filter(Boolean);
          if (variantIds.length > 0) {
            const { rows: compVariants } = await selectRows("variant", { variant_id: `in.(${variantIds.join(",")})` }, { useAnonKey: true });
            variants = compVariants.map(v => ({ ...v, product_id: product.product_id }));
          }

          // Fetch full component product details for combo display
          const componentProductIds = [...new Set(comboItems.map(ci => ci.component_product_id).filter(Boolean))];
          let comboComponents = [];
          if (componentProductIds.length > 0) {
            const { rows: compProducts } = await selectRows("product", { product_id: `in.(${componentProductIds.join(",")})` }, { useAnonKey: true });
            const { rows: compCategories } = await selectRows("category", {}, { useAnonKey: true });
            const compCatMap = new Map(compCategories.map(c => [c.category_id, c.name]));

            // Fetch ALL variants for component products
            const { rows: allCompVariants } = await selectRows("variant", { product_id: `in.(${componentProductIds.join(",")})` }, { useAnonKey: true });
            const compVariantsMap = new Map();
            allCompVariants.forEach(v => {
              if (!compVariantsMap.has(v.product_id)) compVariantsMap.set(v.product_id, []);
              compVariantsMap.get(v.product_id).push(v);
            });

            // Get unique component products (dedupe by product_id)
            const seenProducts = new Set();
            comboComponents = compProducts
              .filter(cp => {
                if (seenProducts.has(cp.product_id)) return false;
                seenProducts.add(cp.product_id);
                return true;
              })
              .map(cp => {
                const item = comboItems.find(ci => ci.component_product_id === cp.product_id);
                const qty = item ? item.quantity : 1;
                const compVariants = compVariantsMap.get(cp.product_id) || [];
                return {
                  product_id: cp.product_id,
                  name: cp.name,
                  slug: cp.slug,
                  images: cp.images || [],
                  base_price: cp.base_price,
                  sale_price: cp.sale_price,
                  category_name: compCatMap.get(cp.category_id) || "",
                  quantity: qty,
                  variants: compVariants.map(v => ({
                    variant_id: v.variant_id,
                    color: v.color,
                    color_hex: v.color_hex,
                    size: v.size,
                    stock_quantity: v.stock_quantity || 0,
                    reserved_quantity: v.reserved_quantity || 0,
                    sku: v.sku
                  }))
                };
              });
          }
          product.combo_components = comboComponents;
          product.total_original_price = comboComponents.reduce((sum, c) => sum + (c.base_price * c.quantity), 0);
          product.combo_savings = product.total_original_price - (product.sale_price || product.base_price);
        } else {
          const { rows: dbVariants } = await selectRows("variant", { product_id: `eq.${action}` }, { useAnonKey: true });
          variants = dbVariants;
        }
        const category = product.category_id ? await selectOne("category", { category_id: `eq.${product.category_id}` }, { useAnonKey: true }) : null;
        
        // Fetch approved reviews for this product
        const { rows: dbReviews } = await selectRows("review", {
          product_id: `eq.${action}`,
          status: "eq.approved"
        }, { useAnonKey: true });
        
        let reviews = [];
        if (dbReviews && dbReviews.length > 0) {
          const userIds = [...new Set(dbReviews.map(r => r.user_id))];
          const { rows: reviewUsers } = await selectRows("users", {
            user_id: `in.(${userIds.join(",")})`
          }, { useAnonKey: true });
          const userMap = new Map(reviewUsers.map(u => [u.user_id, u.full_name]));
          reviews = dbReviews.map(r => ({
            ...r,
            user_full_name: userMap.get(r.user_id) || "Khách hàng ẩn danh"
          }));
        }

        // Calculate sold_count dynamically for this single product
        let sold_count = 0;
        try {
          const { rows: activeOrders } = await selectRows("orders", { status: "neq.cancelled" }, { useAnonKey: true });
          const activeOrderIds = new Set(activeOrders.map(o => o.order_id));

          const variantIds = variants.map(v => v.variant_id);
          const { rows: allOrderItems } = await selectRows("order_item", {}, { useAnonKey: true });

          allOrderItems.forEach(item => {
            if (activeOrderIds.has(item.order_id)) {
              const matchesName = item.product_name && product.name && item.product_name.toLowerCase() === product.name.toLowerCase();
              const matchesVariant = variantIds.includes(item.variant_id);
              if (matchesName || matchesVariant) {
                sold_count += Number(item.quantity || 0);
              }
            }
          });
        } catch (err) {
          console.error("Error calculating sold_count for single product:", err);
        }

        return sendJson(res, 200, { ...product, variants, category, reviews, sold_count }, corsHeaders);
      }

      const { rows: products } = await selectRows("product", { status: "in.(on_sale,out_of_stock)" }, { useAnonKey: true });
      const requestUrl = new URL(req.url || "/api/user/products", "http://localhost");
      const lite = requestUrl.searchParams.get("lite") === "1";
      const { rows: categories } = await selectRows("category", {}, { useAnonKey: true });

      if (lite) {
        const liteRows = products.map((p) => {
          const category = categories.find((c) => c.category_id === p.category_id);
          return {
            product_id: p.product_id,
            sku: p.sku,
            name: p.name,
            slug: p.slug,
            base_price: p.base_price,
            sale_price: p.sale_price,
            images: p.images,
            is_featured: p.is_featured,
            is_combo: p.is_combo,
            status: p.status,
            sold_count: p.sold_count || 0,
            collection: p.collection || null,
            updated_at: p.updated_at || null,
            category_slug: category ? category.slug : null,
            category_name: category ? category.name : null
          };
        });
        return sendJson(res, 200, liteRows, corsHeaders);
      }

      let allVariants = [];
      let variantOffset = 0;
      const variantLimit = 1000;
      while (true) {
        const { rows } = await selectRows("variant", { limit: variantLimit, offset: variantOffset }, { useAnonKey: true });
        if (rows.length === 0) break;
        allVariants = allVariants.concat(rows);
        if (rows.length < variantLimit) break;
        variantOffset += variantLimit;
      }

      let comboItems = [];
      try {
        const comboResult = await selectRows("combo_item", {}, { useAnonKey: true });
        comboItems = comboResult.rows;
      } catch (err) {
        console.error("Error loading combo_item for catalog:", err);
      }
      
      // Calculate bulk sold counts
      const variantSalesMap = new Map();
      const nameSalesMap = new Map();
      try {
        const { rows: activeOrders } = await selectRows("orders", { status: "neq.cancelled" }, { useAnonKey: true });
        const activeOrderIds = new Set(activeOrders.map(o => o.order_id));

        const { rows: orderItems } = await selectRows("order_item", {}, { useAnonKey: true });
        orderItems.forEach(item => {
          if (activeOrderIds.has(item.order_id)) {
            const qty = Number(item.quantity || 0);
            if (item.variant_id) {
              variantSalesMap.set(item.variant_id, (variantSalesMap.get(item.variant_id) || 0) + qty);
            }
            if (item.product_name) {
              const nameKey = item.product_name.toLowerCase();
              nameSalesMap.set(nameKey, (nameSalesMap.get(nameKey) || 0) + qty);
            }
          }
        });
      } catch (err) {
        console.error("Error calculating bulk sold counts:", err);
      }

      // Calculate bulk reviews
      const ratingMap = new Map();
      try {
        const { rows: allReviews } = await selectRows("review", { select: "*", status: "eq.approved" }, { useAnonKey: true });
        if (allReviews) {
          allReviews.forEach(r => {
            if (!ratingMap.has(r.product_id)) {
              ratingMap.set(r.product_id, { sum: 0, count: 0 });
            }
            const data = ratingMap.get(r.product_id);
            data.sum += Number(r.rating || 0);
            data.count += 1;
          });
        }
      } catch (err) {
        console.error("Error calculating bulk reviews:", err);
      }

      const productsWithVariants = products.map(p => {
        let variants = [];
        if (p.is_combo) {
          const itemVariantIds = comboItems
            .filter(ci => ci.combo_product_id === p.product_id)
            .map(ci => ci.component_variant_id);
          variants = allVariants
            .filter(v => itemVariantIds.includes(v.variant_id))
            .map(v => ({ ...v, product_id: p.product_id }));
        } else {
          variants = allVariants.filter(v => v.product_id === p.product_id);
        }

        // Calculate sold_count based on either matching name or variants
        let sold_count = 0;
        if (p.name) {
          sold_count = nameSalesMap.get(p.name.toLowerCase()) || 0;
        }
        if (sold_count === 0) {
          variants.forEach(v => {
            sold_count += variantSalesMap.get(v.variant_id) || 0;
          });
        }

        const reviewData = ratingMap.get(p.product_id);
        let rating_value = 0;
        let rating_count = 0;
        if (reviewData && reviewData.count > 0) {
          rating_value = Number((reviewData.sum / reviewData.count).toFixed(1));
          rating_count = reviewData.count;
        }

        const category = categories.find(c => c.category_id === p.category_id);
        return { 
          ...p, 
          variants, 
          category_slug: category ? category.slug : null, 
          category_name: category ? category.name : null,
          sold_count,
          rating_value,
          rating_count
        };
      });

      return sendJson(res, 200, productsWithVariants, corsHeaders);
    }
  }

  if (subRoute === "categories") {
    if (req.method === "GET") {
      const { rows: categories } = await selectRows("category", {}, { useAnonKey: true });
      const { rows: products } = await selectRows("product", { status: "eq.on_sale" }, { useAnonKey: true });
      const categoriesWithCount = categories.map(c => {
        const count = products.filter(p => p.category_id === c.category_id).length;
        return { ...c, product_count: count };
      });
      return sendJson(res, 200, categoriesWithCount, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route products or categories not found");
}
